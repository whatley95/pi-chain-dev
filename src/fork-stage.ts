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
  private maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.count = this.maxConcurrency;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        this.count = Math.min(this.count + 1, this.maxConcurrency);
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
    while (this.count > 0 && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }

  setMaxConcurrency(n: number): void {
    const newMax = Math.max(1, n);
    const diff = newMax - this.maxConcurrency;
    this.maxConcurrency = newMax;
    this.count = Math.max(0, this.count + diff);
    this.drain();
  }
}

const stageSemaphores = new Map<string, Semaphore>();
let defaultSemaphoreMaxConcurrency = 3;

function getStageSemaphore(cwd: string): Semaphore {
  let sem = stageSemaphores.get(cwd);
  if (!sem) {
    sem = new Semaphore(defaultSemaphoreMaxConcurrency);
    stageSemaphores.set(cwd, sem);
  }
  return sem;
}


/** Clean up all per-cwd semaphore instances. Call on session shutdown. */
export function clearStageSemaphores(): void {
  stageSemaphores.clear();
}


export function setStageSemaphoreMaxConcurrency(n: number): void {
  defaultSemaphoreMaxConcurrency = Math.max(1, n);
  // Update existing semaphores in place
  for (const sem of stageSemaphores.values()) {
    sem.setMaxConcurrency(defaultSemaphoreMaxConcurrency);
  }
}

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

interface PreparedSession {
  jsonl: string;
  filePath: string;
  tmpDir: string;
}

const sharedPreparedSessions = new Map<string, { prepared: PreparedSession; refCount: number }>();
const MAX_SHARED_SESSIONS = 50;

export function prepareSharedSession(sanitizedJsonl: string): PreparedSession {
  const existing = sharedPreparedSessions.get(sanitizedJsonl);
  if (existing) {
    existing.refCount++;
    return existing.prepared;
  }
  // Evict oldest unused entry when at capacity
  if (sharedPreparedSessions.size >= MAX_SHARED_SESSIONS) {
    for (const [key, entry] of sharedPreparedSessions) {
      if (entry.refCount === 0) {
        cleanupTempDir("", entry.prepared.tmpDir);
        sharedPreparedSessions.delete(key);
        break;
      }
    }
    // If no unused entry was found, allow the map to grow by one rather than
    // evicting an in-use session (which would corrupt active forks).
  }
  const tmp = writeTempSessionJsonl(sanitizedJsonl);
  const prepared: PreparedSession = { jsonl: sanitizedJsonl, filePath: tmp.filePath, tmpDir: tmp.dir };
  sharedPreparedSessions.set(sanitizedJsonl, { prepared, refCount: 1 });
  return prepared;
}

export function releaseSharedSession(prepared: PreparedSession): void {
  const entry = sharedPreparedSessions.get(prepared.jsonl);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    cleanupTempDir("", entry.prepared.tmpDir);
    sharedPreparedSessions.delete(prepared.jsonl);
  }
}

function writeTempSessionJsonl(sessionJsonl: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-dev-"));
  const filePath = path.join(tmpDir, "cdev.jsonl");
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

export function clearSharedSession(): void {
  for (const entry of sharedPreparedSessions.values()) {
    cleanupTempDir("", entry.prepared.tmpDir);
  }
  sharedPreparedSessions.clear();
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
  redacted = redacted.replace(/\b(sk-[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]");
  redacted = redacted.replace(/\b([a-f0-9]{64,})\b/gi, "[REDACTED_HEX_KEY]");
  redacted = redacted.replace(/\b([A-Za-z0-9+/]{48,}={0,2})\b/g, "[REDACTED_B64_KEY]");
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

  // Parse lines and collect valid tool-call IDs from assistant messages.
  interface ParsedLine {
    raw: string;
    msg: Record<string, unknown> | null;
    isEnvelope: boolean;
  }
  const parsed: ParsedLine[] = new Array(rawLines.length);
  const validIds = new Set<string>();

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    let msg: Record<string, unknown> | null = null;
    let isEnvelope = false;
    try {
      const obj = JSON.parse(line);
      isEnvelope = obj && typeof obj === "object" && !Array.isArray(obj) && "message" in obj;
      const raw = isEnvelope
        ? (obj as Record<string, unknown>).message as Record<string, unknown>
        : obj;
      msg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    } catch { /* unparseable line — keep raw text */ }
    parsed[i] = { raw: line, msg, isEnvelope };

    // Collect valid tool-call IDs from assistant messages
    if (msg && msg.role === "assistant") {
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
  }

  // Single pass: redact, filter system + orphan tool messages, build output.
  const outLines: string[] = [];
  let stripped = 0;

  for (const entry of parsed) {
    // Redact sensitive content
    let redactedMsg: Record<string, unknown> | null = null;
    if (entry.msg) {
      redactedMsg = redactMessageSensitive(entry.msg);
    }

    // Filter system messages
    if (entry.msg && entry.msg.role === "system") {
      stripped++;
      continue;
    }

    // Filter orphan tool messages
    if (entry.msg && entry.msg.role === "tool") {
      const toolCallId = entry.msg.tool_call_id || entry.msg.call_id;
      if (typeof toolCallId !== "string" || !validIds.has(toolCallId)) {
        stripped++;
        continue;
      }
    }

    // Serialize redacted line
    if (redactedMsg) {
      if (entry.isEnvelope) {
        try {
          const env = JSON.parse(entry.raw);
          env.message = redactedMsg;
          outLines.push(JSON.stringify(env));
        } catch {
          outLines.push(JSON.stringify(redactedMsg));
        }
      } else {
        outLines.push(JSON.stringify(redactedMsg));
      }
    } else {
      outLines.push(entry.raw);
    }
  }

  return {
    jsonl: outLines.join("\n") + "\n",
    stripped,
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
    args.push("--tools", "read,bash,ls,grep,rg,find,cat,multiRead");
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
  if (stageProfile.thinking) args.push("--thinking", stageProfile.thinking);

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

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export async function runStageWithRetry(opts: RunStageOptions): Promise<ForkResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  let lastResult: ForkResult | undefined;
  const stageStart = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) break;
    const release = await getStageSemaphore(opts.cwd).acquire();
    try {
      const result = await runStageCore({ ...opts, stageLabel: attempt > 0 ? `${opts.stageLabel} (retry ${attempt})` : opts.stageLabel });
      result.durationMs = Date.now() - stageStart;
      lastResult = result;
      if (result.exitCode === 0 || getFinalAssistantText(result.messages) || opts.signal?.aborted) {
        return result;
      }
      if (attempt < retries) {
        result.stderr += `[cdev] retrying ${opts.stageLabel} stage (${attempt + 1}/${retries})\n`;
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        if (opts.signal?.aborted) break;
        await sleep(delayMs, opts.signal);
      }
    } finally {
      release();
    }
  }
  if (lastResult) {
    lastResult.durationMs = Date.now() - stageStart;
    return lastResult;
  }
  return emptyFailedResult(opts.task, `${opts.stageLabel} stage failed after ${retries} retries`);
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

  const sanitized = sanitizedSessionJsonl
    ?? (forkSessionJsonl ? sanitizeSessionJsonl(forkSessionJsonl) : { jsonl: "", stripped: 0 });
  if (sanitized.stripped > 0) {
    result.stderr += `[cdev] stripped ${sanitized.stripped} orphaned tool message(s) from session snapshot\n`;
  }
  // Use a shared temp session file when the caller prepared one; otherwise fall back to a per-run temp file.
  const prepared = sanitizedSessionJsonl ? prepareSharedSession(sanitized.jsonl) : null;
  let offloadTmpDir: string | null = null;
  let sessionFilePath = prepared ? prepared.filePath : (() => {
    const tmp = writeTempSessionJsonl(sanitized.jsonl);
    offloadTmpDir = tmp.dir;
    return tmp.filePath;
  })();
  let taskArg = task;
  let exitCode: number;

  try {
    const { command, prefixArgs } = resolvePiSpawn();

    const effectiveToolMode = toolMode ?? (noTools ? "forge" : null);
    const testArgs = buildPiArgs(taskArg, sessionFilePath, extensions, stageProfile, effectiveToolMode);
    if (estimateCommandLineLength(command, [...prefixArgs, ...testArgs]) > MAX_COMMAND_LINE_LENGTH) {
      const combinedJsonl = appendTaskToSessionJsonl(sanitized.jsonl, task);
      // If we are sharing a prepared session, do not mutate the shared file on disk;
      // retries or concurrent stages may reuse it. Write the offloaded task to a private temp file.
      if (prepared) {
        const tmp = writeTempSessionJsonl(combinedJsonl);
        offloadTmpDir = tmp.dir;
        sessionFilePath = tmp.filePath;
      } else {
        fs.writeFileSync(sessionFilePath, combinedJsonl, { encoding: "utf-8", mode: 0o600 });
      }
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
    let killed = false;
    let abortHandler: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimeoutId: ReturnType<typeof setTimeout> | undefined;

    const killProc = () => {
      if (killed || !proc.pid) return;
      killed = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      sigkillTimeoutId = setTimeout(() => {
        if (settled || !proc.pid) return;
        if (process.platform === "win32") {
          try {
            spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" }).unref();
          } catch { /* ignore */ }
        } else {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }
        sigkillTimeoutId = undefined;
      }, SIGKILL_TIMEOUT_MS);
    };

    const settle = (exitCode: number) => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
      if (sigkillTimeoutId) { clearTimeout(sigkillTimeoutId); sigkillTimeoutId = undefined; }
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      proc.stdout.off("data", onStdoutData);
      proc.stderr.removeAllListeners("data");
      if (buffer.trim()) flushLine(buffer);
      if (!settled) { settled = true; resolve(exitCode); }
    };

    const flushLine = (line: string) => {
      try {
        const { handled, event } = processPiJsonLine(line, result);
        if (handled && onUpdate && event) {
          const summary = summarizePiEvent(event as { type: string; [key: string]: unknown });
          if (summary) {
            onUpdate({ stage: stageLabel, activity: summary, cost: result.usage?.cost, tokens: result.usage?.contextTokens });
          }
        }
        return handled;
      } catch {
        return false;
      }
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

    proc.on("close", (code, signal) => {
      const effectiveCode = code ?? (signal ? 1 : 0);
      settle(effectiveCode);
    });

    proc.on("error", (err) => {
      if (!settled) {
        if (!result.stderr.trim()) result.stderr = err.message;
        settle(1);
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
    if (prepared) {
      releaseSharedSession(prepared);
    }
    if (offloadTmpDir) {
      cleanupTempDir(cwd, offloadTmpDir);
    }
  }
}
