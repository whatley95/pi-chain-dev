/**
 * Two-stage auto-fork runner.
 *
 * Stage 1: Spawn child pi with cheap model → raw exploration findings.
 * Stage 2: Spawn child pi with powerful model → structured report.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv } from "./env.js";
import { extractFilePaths } from "./memory.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine, getFinalAssistantText, summarizePiEvent } from "./runner-events.js";
import type { StageProfile, ForkResult, UsageStats, AutoForkDetails, Stage1Findings } from "./types.js";
import { emptyUsage, emptyFailedResult, isStage1Findings } from "./types.js";

const SIGKILL_TIMEOUT_MS = 5000;

// ── Concurrency control ────────────────────────────────────

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

/** Max concurrent child Pi processes across all cdev forks. */
const stageSemaphore = new Semaphore(2);

// ── Helpers ────────────────────────────────────────────────

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
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

/**
 * Redact sensitive content (API keys, tokens) from strings before
 * forwarding them to child processes that may use different AI providers.
 */
function redactSensitiveContent(text: string): string {
  if (!text) return text;
  let redacted = text;
  // OpenAI / Anthropic common patterns (sk-..., sk-ant-..., etc.)
  redacted = redacted.replace(/\b(sk-[a-zA-Z0-9_\-]{20,})\b/g, "[REDACTED_API_KEY]");
  // Generic hex key patterns (40+ chars)
  redacted = redacted.replace(/\b([a-f0-9]{40,})\b/gi, "[REDACTED_HEX_KEY]");
  // Base64-looking API keys
  redacted = redacted.replace(/\b([A-Za-z0-9+/]{40,}={0,2})\b/g, "[REDACTED_B64_KEY]");
  // --api-key value patterns
  redacted = redacted.replace(/(--api-key\s+)\S+/gi, "$1[REDACTED]");
  return redacted;
}

/**
 * Recursively redact sensitive fields from a message object tree.
 */
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

/**
 * Sanitize a session JSONL snapshot before passing it to a child pi process.
 *
 * 1. Redacts API keys and other sensitive content from ALL message payloads
 * 2. Strips orphaned tool-result messages (matching assistant tool_calls removed)
 * 3. Removes system messages that may contain provider-specific configuration
 *
 * Redaction runs unconditionally on every message — regardless of whether
 * stripping occurs. This prevents API key leaks even in clean sessions.
 *
 * Strips orphaned tool-result messages whose preceding assistant message
 * (with matching tool_calls) was removed — e.g. by context truncation or
 * stale session state after a provider switch. Without this, the child pi
 * would send invalid conversation history to the AI API and get a 400 error:
 * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'."
 *
 * Handles both OpenAI (tool_calls array) and Anthropic (tool_use content blocks) formats.
 * Non-message envelope entries (headers, etc.) pass through unchanged.
 */
function sanitizeSessionJsonl(sessionJsonl: string): { jsonl: string; stripped: number } {
  if (!sessionJsonl || !sessionJsonl.trim()) return { jsonl: sessionJsonl, stripped: 0 };

  const rawLines = sessionJsonl.trim().split("\n");
  if (rawLines.length <= 1) return { jsonl: sessionJsonl, stripped: 0 };

  // Parse each line; unwrap envelope objects that have a .message property.
  // Caches whether the line was an envelope to avoid re-parsing in Pass 1.
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

  // ── Pass 1: Always redact sensitive content from ALL message payloads ──
  const redacted = parsed.map((entry) => {
    if (!entry.msg) return entry; // Non-message entries pass through
    const redactedMsg = redactMessageSensitive(entry.msg);
    // Preserve message envelope if one existed
    if (entry.isEnvelope) {
      try {
        const env = JSON.parse(entry.raw);
        env.message = redactedMsg;
        return { raw: JSON.stringify(env), msg: redactedMsg, isEnvelope: true };
      } catch { /* fall through — can't re-wrap, treat as plain message */ }
    }
    return { raw: JSON.stringify(redactedMsg), msg: redactedMsg, isEnvelope: false };
  });

  // ── Pass 2: Collect valid tool_call_ids from all assistant messages ──
  const validIds = new Set<string>();
  for (const entry of redacted) {
    const msg = entry.msg;
    if (!msg) continue;
    if (msg.role !== "assistant") continue;

    // OpenAI format: tool_calls array on the message
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && typeof tc === "object") {
          const id = (tc as Record<string, unknown>).id || (tc as Record<string, unknown>).call_id;
          if (typeof id === "string") validIds.add(id);
        }
      }
    }
    // Anthropic format: tool_use blocks inside content array
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

  // ── Pass 3: Strip system messages ──
  let systemStripped = 0;
  const noSystem = redacted.filter((entry) => {
    const msg = entry.msg;
    if (msg && msg.role === "system") { systemStripped++; return false; }
    return true;
  });

  // ── Pass 4: Filter out orphaned tool messages ──
  let orphanStripped = 0;
  const sanitized = noSystem.filter((entry) => {
    const msg = entry.msg;
    if (!msg) return true; // Non-message entries always pass through
    if (msg.role !== "tool") return true; // Non-tool messages always pass through

    // Check if this tool message references a valid assistant tool_calls id
    const toolCallId = msg.tool_call_id || msg.call_id;
    if (typeof toolCallId !== "string") return true; // No id to validate, keep it

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

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Prompts ────────────────────────────────────────────────

/** Audit guard — stages never modify code */
const STAGE_AUDIT_GUARD = "\n\n⚠️ AUDIT ONLY — DO NOT implement, modify, or write any code. Only report findings and suggestions.";

function buildStage1Prompt(task: string, customPrompt?: string): string {
  const jsonSchema = `{
  "summary": "one-sentence summary of what was explored",
  "findings": [
    {
      "file": "optional relative file path",
      "observation": "concrete observation",
      "evidence": "supporting snippet, command output, or value",
      "confidence": "high|medium|low"
    }
  ],
  "deadEnds": ["optional paths that did not pan out"],
  "assumptions": ["optional assumptions made"],
  "openQuestions": ["optional questions for the main agent"]
}`;
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

Return your findings as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}${STAGE_AUDIT_GUARD}`;
  }
  return `${task}

You are in EXPLORATION MODE. Your job is to gather information, not to write a final report.

Instructions:
- Explore thoroughly using available tools (read, bash, ls, grep, etc.)
- Gather concrete evidence: file contents, command outputs, config values
- Return your findings as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Rules:
- "summary" is required and must be one sentence.
- "findings" is required. Each finding must have "observation" and "confidence".
- "file" and "evidence" are optional but strongly preferred when applicable.
- "deadEnds", "assumptions", "openQuestions" are optional.
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings" outside the JSON.
- Do NOT write a decision-useful report. Only return the JSON object.${STAGE_AUDIT_GUARD}`;
}

function formatStage1FindingsForStage2(findings: Stage1Findings): string {
  const lines: string[] = [];
  lines.push(`Summary: ${findings.summary}`);
  if (findings.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const f of findings.findings) {
      const parts: string[] = [`- [${f.confidence || "medium"}] ${f.observation}`];
      if (f.file) parts.push(`  file: ${f.file}`);
      if (f.evidence) parts.push(`  evidence: ${f.evidence}`);
      lines.push(parts.join("\n"));
    }
  }
  if (findings.deadEnds?.length) {
    lines.push("");
    lines.push("Dead ends:");
    for (const d of findings.deadEnds) lines.push(`- ${d}`);
  }
  if (findings.assumptions?.length) {
    lines.push("");
    lines.push("Assumptions:");
    for (const a of findings.assumptions) lines.push(`- ${a}`);
  }
  if (findings.openQuestions?.length) {
    lines.push("");
    lines.push("Open questions:");
    for (const q of findings.openQuestions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
}

function buildStage2Prompt(task: string, stage1Output: string, customPrompt?: string): string {
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

<previous_findings>
${stage1Output}
</previous_findings>${STAGE_AUDIT_GUARD}`;
  }
  return `${task}

A previous exploration stage gathered these raw findings:

<previous_findings>
${stage1Output}
</previous_findings>

Your job: synthesize these findings into a decision-useful report. You do NOT need to explore further — work with the findings above.

Use this exact structure:

## Result

Say what happened in the fewest bullets that are still useful. Include status, outcome, changes, and confidence/caveats if relevant.

## Output

Give the useful substance. Adapt to the task type (exploration, debugging, implementation, review, etc.). Include concrete flow, tradeoffs, decisions, and reasoning.

## Evidence

Include concrete anchors to trust/verify/continue: paths, symbols, snippets, commands, config keys, error messages. Prefer decisive snippets and exact anchors over paraphrase.

## Learnings

Extract reusable knowledge: dead ends, failed attempts, wrong assumptions, hidden coupling, source-of-truth discoveries, project mental models. Use "Learning / Evidence / Reuse when" format.

## Action Items

If you identified specific things that should be done, list them as checkboxes. The main agent will mark them complete after implementing.

- [ ] item 1
- [ ] item 2

Assembly rules:
- Always use exactly these five headings: Result, Output, Evidence, Learnings, Action Items
- Right-size each section independently
- Do not compress away important evidence
- Do not narrate tool calls
- If no files changed, say "No changes made" once
- Report what changes future decisions, trust, or behavior
- Action Items should be concrete, verifiable tasks the agent can check off${STAGE_AUDIT_GUARD}`;
}

// ── Stage 1 structured findings ────────────────────────────

function extractJsonFromText(text: string): string | null {
  const trimmed = text.trim();
  // Markdown fenced code block
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Bare JSON object
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) return objectMatch[0];
  return null;
}

export function parseStage1Findings(text: string): Stage1Findings | null {
  const jsonText = extractJsonFromText(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (!isStage1Findings(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validateStage1Findings(findings: Stage1Findings, source: string): { valid: boolean; reason?: string } {
  if (!findings.summary || findings.summary.trim().length < 5) {
    return { valid: false, reason: `${source}: summary missing or too short` };
  }
  if (findings.findings.length === 0) {
    return { valid: false, reason: `${source}: no findings returned` };
  }
  const withObservations = findings.findings.filter(f => f.observation && f.observation.trim().length > 0);
  if (withObservations.length === 0) {
    return { valid: false, reason: `${source}: findings lack observations` };
  }
  return { valid: true };
}

/** Deduplicate findings by observation text similarity (case-insensitive prefix match). */
function normalizeObservation(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function findingsOverlap(a: string, b: string): boolean {
  const na = normalizeObservation(a);
  const nb = normalizeObservation(b);
  if (na === nb) return true;
  if (na.length > 20 && nb.length > 20) {
    return na.startsWith(nb.slice(0, 40)) || nb.startsWith(na.slice(0, 40));
  }
  return false;
}

export function mergeStage1Findings(a: Stage1Findings, b: Stage1Findings): Stage1Findings {
  const merged: Stage1Findings = {
    summary: a.summary,
    findings: [...a.findings],
    deadEnds: [...(a.deadEnds ?? [])],
    assumptions: [...(a.assumptions ?? [])],
    openQuestions: [...(a.openQuestions ?? [])],
  };
  for (const f of b.findings) {
    if (!merged.findings.some(existing => findingsOverlap(existing.observation, f.observation))) {
      merged.findings.push(f);
    }
  }
  for (const list of ["deadEnds", "assumptions", "openQuestions"] as const) {
    const source = b[list] ?? [];
    for (const item of source) {
      if (!merged[list]?.some(existing => normalizeObservation(existing) === normalizeObservation(item))) {
        merged[list] = merged[list] ?? [];
        merged[list].push(item);
      }
    }
  }
  // Use longer/more detailed summary if b has more findings
  if (b.findings.length > a.findings.length && b.summary.length >= a.summary.length) {
    merged.summary = b.summary;
  }
  return merged;
}

// ── Review mode prompts ────────────────────────────────────

function buildReviewPrompt(customPrompt?: string): string {
  if (customPrompt) return customPrompt + STAGE_AUDIT_GUARD;
  return `Review the code changes made in this session. Your job is to find issues the developer may have missed.

Instructions:
- Examine all changed files and recent edits
- Find bugs, edge cases, missing error handling, security concerns
- Check for style inconsistencies, naming issues, dead code
- Verify that no existing tests are broken
- Suggest concrete improvements with code snippets where helpful

Use this structure:

## Result
Summary of review: pass / needs-work / blocked. Key concerns in bullets.

## Issues Found
Each issue as: File, Line, Severity, Description, Fix suggestion.

## Suggestions
Improvements that aren't bugs: refactors, patterns, tests to add.

## Evidence
Files reviewed, diff locations, edge cases verified, assumptions checked.

Be direct. Flag real problems loudly. Don't praise trivial things.${STAGE_AUDIT_GUARD}`;
}

function buildFileReviewPrompt(
  filePath: string,
  reportContent: string,
  referencedFiles: Record<string, string>,
): string {
  const auditSuffix = STAGE_AUDIT_GUARD;
  const fileList = Object.keys(referencedFiles);
  const filesSection = fileList.length > 0
    ? fileList.map(f => {
        const content = referencedFiles[f];
        const truncated = content.length > 3000
          ? content.slice(0, 3000) + "\n\n... (truncated, full file is longer)"
          : content;
        return `### ${f}\n\`\`\`\n${truncated}\n\`\`\``;
      }).join("\n\n")
    : "(no referenced files found in the report)";

  return `Review the following report AND the actual code it references. Your job: compare what the report claims against what the code actually contains.

Report: ${filePath}

Instructions:
- Compare each claim in the report against the actual file contents below
- Find mismatches: things the report says were done but aren't in the code
- Find bugs: issues in the actual code that the report didn't catch
- Find gaps: report claims that lack corresponding implementation
- Check if Action Items marked done are genuinely resolved in the code
- Flag anything the report claims that contradicts the actual code

Use this structure:

## Result
Summary: pass / needs-work / blocked. Did the implementation match the report?

## Claims vs Code
For each key claim in the report, verify against the actual files. Format:
**Claim:** what the report says
**Reality:** what the code actually shows
**Verdict:** ✅ matched / ⚠️ partial / ❌ missing

## Bugs Found
Issues in the actual code (not report claims): File, Line, Severity, Description.

## Gaps
Things the report says are done but aren't reflected in code.

## New Action Items
List any new tasks surfaced by this review as checkboxes the main agent can act on.

- [ ] item 1
- [ ] item 2

## What's Missing
Considerations neither the report nor the code address.

---

<report>
${reportContent}
</report>

<actual-files>
${filesSection}
</actual-files>${auditSuffix}`;
}

function buildDiffReviewPrompt(diffSpec: string, diffContent: string): string {
  const maxLen = 40000;
  const truncated = diffContent.length > maxLen
    ? diffContent.slice(0, maxLen) + `\n\n... (diff truncated for review — ${diffContent.length - maxLen} more chars)`
    : diffContent;

  return `Review the following code diff thoroughly. Find bugs, edge cases, missing error handling, security concerns, and gaps.

Diff: ${diffSpec}

Instructions:
- Examine every changed file and every changed line
- Find bugs introduced by these changes
- Check for missing error handling, null guards, edge cases
- Look for security concerns (injection, auth bypass, data leaks)
- Verify that changes don't break existing patterns or conventions
- Check for dead code, unused imports, leftover debug statements
- Suggest concrete fixes with code snippets where helpful

Use this structure:

## Result
Summary: pass / needs-work / blocked. Key concerns in bullets.

## Issues Found
Each issue as: File, Line, Severity, Description, Fix suggestion.

## New Action Items
List any fixes needed as checkboxes.

- [ ] item 1
- [ ] item 2

## Suggestions
Improvements that aren't bugs: refactors, tests, patterns.

---

<diff>
${truncated}
</diff>${STAGE_AUDIT_GUARD}`;
}

// ── Stage runner ────────────────────────────────────────────

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function buildPiArgs(
  task: string,
  forkSessionPath: string,
  extensions: string[] | null,
  stageProfile: StageProfile,
  noTools = false,
  temperature?: number,
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

  // Inherited fallback — only used if stage profile doesn't provide its own.
  // Tools use !stageProfile.id as proxy (no stageProfile.tools field yet).
  if (inheritedCliArgs.fallbackModel && !stageProfile.id) {
    args.push("--model", inheritedCliArgs.fallbackModel);
  }
  if (inheritedCliArgs.fallbackThinking && !stageProfile.thinking) {
    args.push("--thinking", inheritedCliArgs.fallbackThinking);
  }
  if (noTools) {
    args.push("--no-tools");
  } else if (!stageProfile.id) {
    if (inheritedCliArgs.fallbackTools) {
      args.push("--tools", inheritedCliArgs.fallbackTools);
    }
    if (inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  // Stage profile overrides
  args.push("--provider", stageProfile.provider);
  args.push("--model", stageProfile.id);
  args.push("--thinking", stageProfile.thinking);

  if (typeof temperature === "number") {
    args.push("--temperature", String(temperature));
  }

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
  /** If true, pass --no-tools so the child process cannot modify files */
  noTools?: boolean;
  /** Max wall-clock ms before the stage is force-killed. 0 = no limit. */
  stageTimeoutMs?: number;
  /**
   * If provided, skip redundant sanitization of forkSessionJsonl.
   * Useful when the same snapshot is reused across stages.
   */
  sanitizedSessionJsonl?: { jsonl: string; stripped: number };
  /** Number of retries on spawn/early-exit failures. */
  retries?: number;
  /** Optional sampling temperature for the stage model. */
  temperature?: number;
  /**
   * Optional callback invoked when a JSON event line is parsed during the stage.
   * Allows callers to show live progress.
   */
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
}

async function runStageWithRetry(opts: RunStageOptions): Promise<ForkResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  let lastResult: ForkResult | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const release = await stageSemaphore.acquire();
    try {
      const result = await runStageCore({ ...opts, stageLabel: attempt > 0 ? `${opts.stageLabel} (retry ${attempt})` : opts.stageLabel });
      lastResult = result;
      // Retry only on hard failure with no assistant output and no explicit abort
      if (result.exitCode === 0 || getFinalAssistantText(result.messages) || opts.signal?.aborted) {
        return result;
      }
      if (attempt < retries) {
        result.stderr += `[cdev] retrying ${opts.stageLabel} stage (${attempt + 1}/${retries})\n`;
      }
    } finally {
      release();
    }
  }
  return lastResult ?? emptyFailedResult(opts.task, `${opts.stageLabel} stage failed after ${retries} retries`);
}

async function runStageCore(opts: RunStageOptions): Promise<ForkResult> {
  const { cwd, task, stageLabel, forkSessionJsonl, stageProfile, extensions,
          environment, offline, signal, noTools = false, stageTimeoutMs = 0,
          sanitizedSessionJsonl, temperature, onUpdate } = opts;

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
  const piArgs = buildPiArgs(task, tmp.filePath, extensions, stageProfile, noTools, temperature);

  const exitCode = await new Promise<number>((resolve) => {
    const { command, prefixArgs } = resolvePiSpawn();
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

  // Determine provider/model from messages or stage profile
  if (!result.provider) result.provider = stageProfile.provider;
  if (!result.model) result.model = stageProfile.id;

  cleanupTempDir(tmp.dir);
  return result;
}

// ── Main auto-fork orchestrator ──────────────────────────────

export interface RunAutoForkOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl: string;
  stage1Profile: StageProfile;
  stage2Profile: StageProfile;
  customExplorePrompt?: string;
  customSynthesizePrompt?: string;
  /** If true, skip stage 2 — return raw stage 1 findings only. */
  quick?: boolean;
  /** If true, run stage 1 twice with different temperatures and merge findings before stage 2. */
  verify?: boolean;
  /** Called when a stage starts. Lets the caller show progress. */
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  /**
   * Called when a stage emits a live activity update.
   * Allows callers to show streaming progress in the UI.
   */
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}

export async function runAutoFork(opts: RunAutoForkOptions): Promise<{
  result: ForkResult;
  details: AutoForkDetails;
}> {
  const { cwd, task, forkSessionSnapshotJsonl, stage1Profile, stage2Profile,
          customExplorePrompt, customSynthesizePrompt,
          quick = false, verify = false,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const details: AutoForkDetails = { stage1: null, stage2: null };

  // Sanitize session snapshot once and reuse across stages
  const sanitizedSnapshot = sanitizeSessionJsonl(forkSessionSnapshotJsonl);

  // ── Stage 1: Exploration with cheap model ──
  const scoutModelLabel = stage1Profile.thinking ? `${stage1Profile.provider}:${stage1Profile.id} • ${stage1Profile.thinking}` : `${stage1Profile.provider}:${stage1Profile.id}`;
  opts.onProgress?.("scout", scoutModelLabel);
  const stage1Task = buildStage1Prompt(task, customExplorePrompt);

  let stage1Result: ForkResult;
  let stage1Findings: Stage1Findings | null = null;
  const onUpdate = opts.onUpdate;

  async function runStage1Run(label: string, temperature?: number): Promise<ForkResult> {
    return runStageWithRetry({
      cwd,
      task: stage1Task,
      stageLabel: label,
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: stage1Profile,
      extensions,
      environment,
      offline,
      signal,
      stageTimeoutMs: 300_000,
      sanitizedSessionJsonl: sanitizedSnapshot,
      retries: 1,
      temperature,
      onUpdate,
    });
  }

  if (verify) {
    // Self-consistency: run stage 1 twice concurrently with different temperatures
    const [runA, runB] = await Promise.all([
      runStage1Run("exploration A", 0.2),
      runStage1Run("exploration B", 0.7),
    ]);

    // Combine usage from both runs into the primary stage1 result
    const combinedUsage: UsageStats = emptyUsage();
    const addUsage = (usage: UsageStats | undefined | null) => {
      if (!usage) return;
      combinedUsage.input += usage.input || 0;
      combinedUsage.output += usage.output || 0;
      combinedUsage.cost += usage.cost || 0;
      combinedUsage.turns += usage.turns || 0;
      combinedUsage.contextTokens = Math.max(combinedUsage.contextTokens, usage.contextTokens || 0);
    };
    addUsage(runA.usage);
    addUsage(runB.usage);

    stage1Result = {
      ...runA,
      task,
      usage: combinedUsage,
      stderr: [runA.stderr, runB.stderr].filter(Boolean).join("\n"),
    };
    details.stage1 = stage1Result;

    const textA = getFinalAssistantText(runA.messages) || "";
    const textB = getFinalAssistantText(runB.messages) || "";
    const findingsA = parseStage1Findings(textA);
    const findingsB = parseStage1Findings(textB);

    const validationA = findingsA ? validateStage1Findings(findingsA, "exploration A") : { valid: false, reason: "exploration A: output was not valid JSON findings" };
    const validationB = findingsB ? validateStage1Findings(findingsB, "exploration B") : { valid: false, reason: "exploration B: output was not valid JSON findings" };

    if (validationA.valid && validationB.valid) {
      stage1Findings = mergeStage1Findings(findingsA!, findingsB!);
      stage1Result.stderr += `\n[cdev] verify mode: merged ${findingsA!.findings.length} + ${findingsB!.findings.length} findings into ${stage1Findings.findings.length} unique findings\n`;
    } else if (validationA.valid) {
      stage1Findings = findingsA;
      stage1Result.stderr += `\n[cdev] verify mode: exploration A valid, B invalid (${validationB.reason}); using A\n`;
    } else if (validationB.valid) {
      stage1Findings = findingsB;
      stage1Result.stderr += `\n[cdev] verify mode: exploration B valid, A invalid (${validationA.reason}); using B\n`;
    } else {
      stage1Result.stderr += `\n[cdev] verify mode: both explorations invalid (${validationA.reason}; ${validationB.reason})\n`;
    }
  } else {
    // Normal mode: run stage 1 once, validate, retry once if invalid
    stage1Result = await runStage1Run("exploration");
    details.stage1 = stage1Result;

    const stage1Text = getFinalAssistantText(stage1Result.messages) || "";
    stage1Findings = parseStage1Findings(stage1Text);
    const validation = stage1Findings ? validateStage1Findings(stage1Findings, "exploration") : { valid: false, reason: "output was not valid JSON findings" };

    if (!validation.valid) {
      stage1Result.stderr += `\n[cdev] ${validation.reason}; retrying stage 1 with stricter prompt\n`;
      const retryResult = await runStage1Run("exploration (validation retry)");
      details.stage1 = retryResult;

      const retryText = getFinalAssistantText(retryResult.messages) || "";
      const retryFindings = parseStage1Findings(retryText);
      const retryValidation = retryFindings ? validateStage1Findings(retryFindings, "exploration retry") : { valid: false, reason: "retry output was not valid JSON findings" };

      if (retryValidation.valid) {
        stage1Findings = retryFindings;
        stage1Result = {
          ...retryResult,
          stderr: [stage1Result.stderr, retryResult.stderr].filter(Boolean).join("\n"),
        };
      } else {
        stage1Result.stderr += `\n[cdev] ${retryValidation.reason}; proceeding with raw text\n`;
        stage1Findings = null;
      }
    }
  }

  if (stage1Result.exitCode > 0 && !getFinalAssistantText(stage1Result.messages)) {
    return {
      result: {
        ...stage1Result,
        task,
        errorMessage: `Exploration stage failed: ${stage1Result.errorMessage || stage1Result.stderr || "unknown error"}`,
      },
      details,
    };
  }

  // Quick mode — skip stage 2, return raw findings
  if (quick) {
    const quickResult: ForkResult = {
      ...stage1Result,
      task,
      stopReason: "quick",
    };
    if (stage1Findings) {
      quickResult.messages = [...stage1Result.messages];
    }
    return { result: quickResult, details };
  }

  // ── Stage 2: Synthesis with powerful model ──
  opts.onProgress?.("forge", stage2Profile.thinking ? `${stage2Profile.provider}:${stage2Profile.id} • ${stage2Profile.thinking}` : `${stage2Profile.provider}:${stage2Profile.id}`);

  const stage1Text = stage1Findings
    ? formatStage1FindingsForStage2(stage1Findings)
    : getFinalAssistantText(stage1Result.messages) || stage1Result.stderr || "(no output from exploration stage)";

  const stage2Task = buildStage2Prompt(task, stage1Text, customSynthesizePrompt);

  let stage2Result: ForkResult;
  try {
    stage2Result = await runStageWithRetry({
      cwd,
      task: stage2Task,
      stageLabel: "synthesis",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: stage2Profile,
      extensions,
      environment,
      offline,
      signal,
      noTools: true,
      stageTimeoutMs: 180_000,
      sanitizedSessionJsonl: sanitizedSnapshot,
      retries: 1,
      onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stage2Result = emptyFailedResult(task, `Stage 2 (synthesis) failed: ${message}`);
  }
  details.stage2 = stage2Result;

  // ── Combine results ──
  const combinedUsage: UsageStats = emptyUsage();
  const addUsage = (usage: UsageStats | undefined | null) => {
    if (!usage) return;
    combinedUsage.input += usage.input || 0;
    combinedUsage.output += usage.output || 0;
    combinedUsage.cost += usage.cost || 0;
    combinedUsage.turns += usage.turns || 0;
    combinedUsage.contextTokens = Math.max(combinedUsage.contextTokens, usage.contextTokens || 0);
  };

  addUsage(stage1Result.usage);
  addUsage(stage2Result.usage);

  const finalResult: ForkResult = {
    task,
    exitCode: stage2Result.exitCode > 0 ? stage2Result.exitCode : 0,
    messages: stage2Result.messages,
    stderr: [stage1Result.stderr, stage2Result.stderr].filter(Boolean).join("\n"),
    usage: combinedUsage,
    provider: stage2Result.provider || stage2Profile.provider,
    model: stage2Result.model || stage2Profile.id,
    stopReason: stage2Result.stopReason,
    errorMessage: stage2Result.errorMessage,
  };

  return { result: finalResult, details };
}

// ── Review-only mode (stage 2 only) ────────────────────────

export async function runCdevReview(opts: {
  cwd: string;
  forkSessionSnapshotJsonl: string;
  stageProfile: StageProfile;
  customReviewPrompt?: string;
  /** Called when review starts. */
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  /** Called when review emits a live activity update. */
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, forkSessionSnapshotJsonl, stageProfile,
          customReviewPrompt,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const reviewTask = buildReviewPrompt(customReviewPrompt);
  opts.onProgress?.("forge", stageProfile.thinking ? `${stageProfile.provider}:${stageProfile.id} • ${stageProfile.thinking}` : `${stageProfile.provider}:${stageProfile.id}`);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task: reviewTask,
      stageLabel: "review",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
      noTools: true,
      stageTimeoutMs: 180_000,
      onUpdate: opts.onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult("review", `Review failed: ${message}`);
  }

  return {
    result,
    details: { stage1: null, stage2: result },
  };
}

// ── File review (review an artifact file) ──────────────────

export async function runFileReview(opts: {
  cwd: string;
  filePath: string;
  fileContent: string;
  stageProfile: StageProfile;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  /** Called when review emits a live activity update. */
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, filePath, fileContent, stageProfile,
          extensions = null, environment = {}, offline = true, signal } = opts;

  // Extract paths using shared extractor from memory.ts
  const filePaths = extractFilePaths(fileContent, cwd);
  const referencedFiles: Record<string, string> = {};
  const MAX_REF_FILES = 15;
  const MAX_REF_BYTES = 100_000;
  let totalBytes = 0;
  for (const candidate of filePaths.slice(0, MAX_REF_FILES)) {
    if (totalBytes >= MAX_REF_BYTES) break;
    const fullPath = path.join(cwd, candidate);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (totalBytes + content.length > MAX_REF_BYTES) {
        referencedFiles[candidate] = content.slice(0, MAX_REF_BYTES - totalBytes) + "\n\n... (truncated, file too large)";
        totalBytes = MAX_REF_BYTES;
      } else {
        referencedFiles[candidate] = content;
        totalBytes += content.length;
      }
    } catch { /* skip unreadable files */ }
  }

  const reviewTask = buildFileReviewPrompt(filePath, fileContent, referencedFiles);
  opts.onProgress?.("forge", stageProfile.thinking ? `${stageProfile.provider}:${stageProfile.id} • ${stageProfile.thinking}` : `${stageProfile.provider}:${stageProfile.id}`);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task: reviewTask,
      stageLabel: "review",
      forkSessionJsonl: JSON.stringify({}) + "\n",
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
      noTools: true,
      stageTimeoutMs: 180_000,
      onUpdate: opts.onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult(filePath, `File review failed: ${message}`);
  }

  return {
    result,
    details: { stage1: null, stage2: result },
  };
}

// ── Diff review (review changes between revisions) ──────────

export async function runDiffReview(opts: {
  cwd: string;
  diffSpec: string;
  diffContent: string;
  stageProfile: StageProfile;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  /** Called when review emits a live activity update. */
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, diffSpec, diffContent, stageProfile,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const reviewTask = buildDiffReviewPrompt(diffSpec, diffContent);
  opts.onProgress?.("forge", stageProfile.thinking ? `${stageProfile.provider}:${stageProfile.id} • ${stageProfile.thinking}` : `${stageProfile.provider}:${stageProfile.id}`);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task: reviewTask,
      stageLabel: "review",
      forkSessionJsonl: JSON.stringify({}) + "\n",
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
      noTools: true,
      stageTimeoutMs: 180_000,
      onUpdate: opts.onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult(diffSpec, `Diff review failed: ${message}`);
  }

  return {
    result,
    details: { stage1: null, stage2: result },
  };
}
