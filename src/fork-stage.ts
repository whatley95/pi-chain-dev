import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv } from "./env.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine, getFinalAssistantText, summarizePiEvent } from "./runner-events.js";
import { PROMPT_VERSION } from "./prompt-version.js";
import type { StageProfile, ForkResult } from "./types.js";
import { emptyUsage, emptyFailedResult } from "./types.js";
import { logWarn } from "./logger.js";

const SIGKILL_TIMEOUT_MS = 5000;

class Semaphore {
  private queue: (() => void)[] = [];
  private count: number;

  constructor(maxConcurrency: number) {
    this.count = maxConcurrency;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        this.count++;
        this.drain();
      };
      if (this.count > 0) {
        this.count--;
        resolve(release);
      } else {
        this.queue.push(() => {
          this.count--;
          resolve(release);
        });
      }
    });
  }

  private drain(): void {
    if (this.count > 0 && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}

const stageSemaphore = new Semaphore(2);

let testPiSpawnResolver: (() => { command: string; prefixArgs: string[] }) | null = null;

/** Test hook: override the Pi binary used by runStageCore. */
export function setPiSpawnResolver(resolver: (() => { command: string; prefixArgs: string[] }) | null): void {
  testPiSpawnResolver = resolver;
}

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  if (testPiSpawnResolver) return testPiSpawnResolver();
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  const isBun = /[\\/]bun(?:\.exe)?$/i.test(process.execPath);
  if ((isNode || isBun) && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

function writeTempSessionJsonl(sessionJsonl: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-dev-"));
  const filePath = path.join(tmpDir, "cdev.jsonl");
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

export function appendTaskToSessionJsonl(sessionJsonl: string, task: string): string {
  const lines = sessionJsonl.trim().split("\n").filter(Boolean);
  lines.push(JSON.stringify({
    type: "message",
    role: "system",
    name: "cdev-task",
    cdev_prompt_version: PROMPT_VERSION,
    content: [{ type: "text", text: `cdev task for this fork: ${task}` }],
  }));
  lines.push(JSON.stringify({
    type: "message",
    role: "user",
    content: [{ type: "text", text: "Respond to the cdev task above." }],
  }));
  return lines.join("\n") + "\n";
}

export function estimateCommandLineLength(command: string, args: string[]): number {
  const overhead = args.length * 2;
  return command.length + args.reduce((sum, arg) => sum + arg.length + 1, 0) + overhead + 1;
}

const MAX_COMMAND_LINE_LENGTH = process.platform === "win32" ? 30000 : 200000;

function redactSensitiveContent(text: string): string {
  if (!text) return text;
  let redacted = text;
  redacted = redacted.replace(/\b(sk-[a-zA-Z0-9_]{20,})\b/g, "[REDACTED_API_KEY]");
  redacted = redacted.replace(/\b([a-f0-9]{40,})\b/gi, "[REDACTED_HEX_KEY]");
  redacted = redacted.replace(/\b([A-Za-z0-9+/]{40,}={0,2})\b/g, "[REDACTED_B64_KEY]");
  redacted = redacted.replace(/(--api-key\s+)\S+/gi, "$1[REDACTED]");
  return redacted;
}

function redactMessageSensitive(msg: Record<string, unknown>, seen = new WeakSet<object>()): Record<string, unknown> {
  if (!msg || typeof msg !== "object") return msg;
  if (seen.has(msg as object)) return msg;
  seen.add(msg as object);
  const result: Record<string, unknown> = { ...msg };
  for (const key of Object.keys(result)) {
    const val = result[key];
    if (typeof val === "string") {
      result[key] = redactSensitiveContent(val);
    } else if (Array.isArray(val)) {
      result[key] = val.map((item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? redactMessageSensitive(item as Record<string, unknown>, seen)
          : item
      );
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      result[key] = redactMessageSensitive(val as Record<string, unknown>, seen);
    }
  }
  return result;
}

export function sanitizeSessionJsonl(sessionJsonl: string): { jsonl: string; stripped: number } {
  if (!sessionJsonl || !sessionJsonl.trim()) return { jsonl: sessionJsonl, stripped: 0 };

  const rawLines = sessionJsonl.trim().split("\n");

  interface ParsedLine {
    raw: string;
    msg: Record<string, unknown> | null;
    isEnvelope: boolean;
  }
  const parsed: ParsedLine[] = [];
  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      const isEnvelope =
        obj && typeof obj === "object" && !Array.isArray(obj) && "message" in obj;
      const msg = isEnvelope
        ? (obj as Record<string, unknown>).message as Record<string, unknown>
        : obj;
      parsed.push({
        raw: line,
        msg: msg && typeof msg === "object" && !Array.isArray(msg) ? (msg as Record<string, unknown>) : null,
        isEnvelope: Boolean(isEnvelope),
      });
    } catch {
      parsed.push({ raw: line, msg: null, isEnvelope: false });
    }
  }

  const redacted = parsed.map((entry) => {
    if (!entry.msg) return entry;
    const redactedMsg = redactMessageSensitive(entry.msg);
    if (entry.isEnvelope) {
      try {
        const env = JSON.parse(entry.raw);
        env.message = redactedMsg;
        return { raw: JSON.stringify(env), msg: redactedMsg, isEnvelope: true };
      } catch { /* fall through */ }
    }
    return { raw: JSON.stringify(redactedMsg), msg: redactedMsg, isEnvelope: false };
  });

  const validIds = new Set<string>();
  for (const entry of redacted) {
    const msg = entry.msg;
    if (!msg) continue;
    if (msg.role !== "assistant") continue;

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && typeof tc === "object") {
          const id = (tc as Record<string, unknown>).id || (tc as Record<string, unknown>).call_id;
          if (typeof id === "string") validIds.add(id);
        }
      }
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use" && typeof b.id === "string") {
            validIds.add(b.id);
          }
        }
      }
    }
  }

  let systemStripped = 0;
  const noSystem = redacted.filter((entry) => {
    const msg = entry.msg;
    if (msg && msg.role === "system") { systemStripped++; return false; }
    return true;
  });

  let orphanStripped = 0;
  const sanitized = noSystem.filter((entry) => {
    const msg = entry.msg;
    if (!msg) return true;
    if (msg.role !== "tool") return true;

    const toolCallId = msg.tool_call_id || msg.call_id;
    if (typeof toolCallId !== "string") return true;

    if (validIds.has(toolCallId)) return true;
    orphanStripped++;
    return false;
  });

  const totalStripped = systemStripped + orphanStripped;

  return {
    jsonl: sanitized.map((e) => e.raw).join("\n") + "\n",
    stripped: totalStripped,
  };
}

function cleanupTempDir(cwd: string, dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logWarn(cwd, "cleanupTempDir", "failed to remove temp session dir", { dir, error: String(err) });
  }
}

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

export function buildPiArgs(
  task: string,
  forkSessionPath: string,
  extensions: string[] | null,
  stageProfile: StageProfile,
  toolMode: "scout" | "forge" | null = null,
): string[] {
  const args: string[] = [
    "--mode", "json",
    ...inheritedCliArgs.alwaysProxy,
    "-p",
    "--session", forkSessionPath,
  ];

  if (extensions !== null) {
    args.push("--no-extensions");
  }

  if (inheritedCliArgs.fallbackModel && !stageProfile.id) {
    args.push("--model", inheritedCliArgs.fallbackModel);
  }
  if (inheritedCliArgs.fallbackThinking && !stageProfile.thinking) {
    args.push("--thinking", inheritedCliArgs.fallbackThinking);
  }

  if (toolMode === "forge") {
    args.push("--no-tools");
  } else if (toolMode === "scout") {
    args.push("--tools", "read,bash,ls,grep,find,cat");
  } else if (!stageProfile.id) {
    if (inheritedCliArgs.fallbackTools) {
      args.push("--tools", inheritedCliArgs.fallbackTools);
    }
    if (inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  args.push("--provider", stageProfile.provider);
  args.push("--model", stageProfile.id);
  args.push("--thinking", stageProfile.thinking);

  if (extensions !== null && extensions.length > 0) {
    for (const extension of extensions) {
      args.push("--extension", extension);
    }
  }

  args.push(task);
  return args;
}

export interface RunStageOptions {
  cwd: string;
  task: string;
  stageLabel: string;
  forkSessionJsonl: string;
  stageProfile: StageProfile;
  extensions: string[] | null;
  environment: Record<string, string>;
  offline: boolean;
  signal?: AbortSignal;
  noTools?: boolean;
  toolMode?: "scout" | "forge";
  stageTimeoutMs?: number;
  sanitizedSessionJsonl?: { jsonl: string; stripped: number };
  retries?: number;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runStageWithRetry(opts: RunStageOptions): Promise<ForkResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  let lastResult: ForkResult | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const release = await stageSemaphore.acquire();
    try {
      const result = await runStageCore({ ...opts, stageLabel: attempt > 0 ? `${opts.stageLabel} (retry ${attempt})` : opts.stageLabel });
      lastResult = result;
      if (result.exitCode === 0 || getFinalAssistantText(result.messages) || opts.signal?.aborted) {
        return result;
      }
      if (attempt < retries) {
        result.stderr += `[cdev] retrying ${opts.stageLabel} stage (${attempt + 1}/${retries})\n`;
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        if (opts.signal?.aborted) break;
        await sleep(delayMs);
      }
    } finally {
      release();
    }
  }
  return lastResult ?? emptyFailedResult(opts.task, `${opts.stageLabel} stage failed after ${retries} retries`);
}

export async function runStageCore(opts: RunStageOptions): Promise<ForkResult> {
  const { cwd, task, stageLabel, forkSessionJsonl, stageProfile, extensions,
          environment, offline, signal, noTools = false, toolMode,
          stageTimeoutMs = 0, sanitizedSessionJsonl, onUpdate } = opts;

  const result: ForkResult = {
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };

  const sanitized = sanitizedSessionJsonl ?? sanitizeSessionJsonl(forkSessionJsonl);
  if (sanitized.stripped > 0) {
    result.stderr += `[cdev] stripped ${sanitized.stripped} orphaned tool message(s) from session snapshot\n`;
  }
  const tmp = writeTempSessionJsonl(sanitized.jsonl);
  const sessionFilePath = tmp.filePath;
  let taskArg = task;
  let exitCode: number;

  try {
    const { command, prefixArgs } = resolvePiSpawn();

    const effectiveToolMode = toolMode ?? (noTools ? "forge" : null);
    const testArgs = buildPiArgs(taskArg, sessionFilePath, extensions, stageProfile, effectiveToolMode);
    if (estimateCommandLineLength(command, [...prefixArgs, ...testArgs]) > MAX_COMMAND_LINE_LENGTH) {
      const combinedJsonl = appendTaskToSessionJsonl(sanitized.jsonl, task);
      fs.writeFileSync(sessionFilePath, combinedJsonl, { encoding: "utf-8", mode: 0o600 });
      taskArg = "respond to the task above";
      result.stderr += `[cdev] task offloaded to session file to avoid command-line length limit\n`;
    }

    const piArgs = buildPiArgs(taskArg, sessionFilePath, extensions, stageProfile, effectiveToolMode);

    exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(command, [...prefixArgs, ...piArgs], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(environment, process.env, process.platform, offline),
    });

    proc.stdin.on("error", () => { /* ignore */ });
    proc.stdin.end();

    let buffer = "";
    let settled = false;
    let abortHandler: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const killProc = () => {
      if (!settled && proc.pid) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => {
          if (!settled && proc.pid) {
            if (process.platform === "win32") {
              try {
                spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" }).unref();
              } catch { /* ignore */ }
            } else {
              try { proc.kill("SIGKILL"); } catch { /* ignore */ }
            }
          }
        }, SIGKILL_TIMEOUT_MS);
      }
    };

    const settle = (exitCode: number) => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (buffer.trim()) flushLine(buffer);
      if (!settled) { settled = true; resolve(exitCode); }
    };

    const flushLine = (line: string) => {
      const parsed = processPiJsonLine(line, result);
      if (parsed && onUpdate) {
        let event: { type?: string; [key: string]: unknown };
        try {
          event = JSON.parse(line) as { type?: string; [key: string]: unknown };
        } catch {
          return parsed;
        }
        const summary = summarizePiEvent(event as { type: string; [key: string]: unknown });
        if (summary) {
          onUpdate({ stage: stageLabel, activity: summary, cost: result.usage?.cost, tokens: result.usage?.contextTokens });
        }
      }
      return parsed;
    };

    const onStdoutData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) flushLine(line);
    };

    proc.stdout.on("data", onStdoutData);

    proc.stderr.on("data", (chunk: Buffer) => {
      result.stderr += chunk.toString();
    });

    proc.on("close", (code) => settle(code ?? 0));

    proc.on("error", (err) => {
      if (!settled) {
        if (!result.stderr.trim()) result.stderr = err.message;
        settled = true;
        resolve(1);
      }
    });

    if (stageTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        result.stderr += `[cdev] ${stageLabel} stage timed out after ${stageTimeoutMs}ms\n`;
        killProc();
      }, stageTimeoutMs);
    }

    if (signal) {
      abortHandler = () => killProc();
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  result.exitCode = exitCode;

  if (!result.provider) result.provider = stageProfile.provider;
  if (!result.model) result.model = stageProfile.id;

  return result;
} finally {
    cleanupTempDir(cwd, tmp.dir);
  }
}
