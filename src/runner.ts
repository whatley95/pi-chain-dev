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
import { saveSession } from "./history.js";
import { writeReportFile } from "./report.js";
import type { StageProfile, ForkResult, UsageStats, AutoForkDetails, Stage1Findings, Stage2Report, YoloConfig, AutoForkConfig } from "./types.js";
import { emptyUsage, emptyFailedResult, isStage1Findings, isStage2Report } from "./types.js";
import { formatResultContent, withAuditGuard } from "./extension-context.js";
import { formatCost, estimateForkCost, getSessionForkCost } from "./extension-context.js";

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

export function appendTaskToSessionJsonl(sessionJsonl: string, task: string): string {
  const lines = sessionJsonl.trim().split("\n").filter(Boolean);
  // Use a system instruction entry so the child sees the task as context rather
  // than an additional user turn. This avoids creating a dangling user message
  // after the snapshot's last assistant response.
  lines.push(JSON.stringify({
    type: "message",
    role: "system",
    name: "cdev-task",
    content: [{ type: "text", text: `cdev task for this fork: ${task}` }],
  }));
  // Add a minimal user message that the child should respond to.
  lines.push(JSON.stringify({
    type: "message",
    role: "user",
    content: [{ type: "text", text: "Respond to the cdev task above." }],
  }));
  return lines.join("\n") + "\n";
}

export function estimateCommandLineLength(command: string, args: string[]): number {
  // Windows CreateProcess limit is 32,767 Unicode chars; cmd.exe is much lower.
  // Leave generous headroom for quoting/escaping. Unix limits are much larger.
  const overhead = args.length * 2; // quotes/spaces per arg
  return command.length + args.reduce((sum, arg) => sum + arg.length + 1, 0) + overhead + 1;
}

const MAX_COMMAND_LINE_LENGTH = process.platform === "win32" ? 30000 : 200000;

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
  // Even a single-line snapshot may contain secrets or system messages.
  // Treat it the same way as multi-line snapshots so redaction is unconditional.

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

function buildStage1Prompt(task: string, customPrompt?: string, editMode?: boolean): string {
  const guard = editMode ? "" : STAGE_AUDIT_GUARD;
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
${jsonSchema}

Efficiency rules:
- Batch reads: use \`bash\`, \`cat\`, \`grep\`, \`find\`, \`ls\`, or globs instead of many individual \`read\` calls.
- Example: \`bash: cat src/**/*.ts | grep -n "pattern"\` reads many files in one tool call.
- Read a file individually only when you need the full content of a specific, named file.${guard}`;
  }
  return `${task}

You are in EXPLORATION MODE. Your job is to gather information, not to write a final report.

Instructions:
- Explore thoroughly using available tools (read, bash, ls, grep, find, etc.)
- Gather concrete evidence: file contents, command outputs, config values
- Return your findings as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Efficiency rules:
- Batch reads: use \`bash\`, \`cat\`, \`grep\`, \`find\`, \`ls\`, or globs instead of many individual \`read\` calls.
- Example: \`bash: cat src/**/*.ts | grep -n "pattern"\` reads many files in one tool call.
- Read a file individually only when you need the full content of a specific, named file.
- Stop exploring once you have enough evidence to answer the task.

Rules:
- "summary" is required and must be one sentence.
- "findings" is required. Each finding must have "observation" and "confidence".
- "file" and "evidence" are optional but strongly preferred when applicable.
- "deadEnds", "assumptions", "openQuestions" are optional.
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings" outside the JSON.
- Do NOT write a decision-useful report. Only return the JSON object.${guard}`;
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

function buildStage2Prompt(task: string, stage1Output: string, customPrompt?: string, editMode?: boolean): string {
  const guard = editMode ? "" : STAGE_AUDIT_GUARD;
  const jsonSchema = `{
  "status": "ok|needs-work|blocked|exploratory",
  "summary": "one-paragraph summary of the synthesis",
  "output": "key findings, decisions, or explanations as a single string",
  "evidence": "concrete anchors: paths, snippets, commands, config keys",
  "learnings": "reusable knowledge: dead ends, wrong assumptions, couplings",
  "actionItems": ["concrete verifiable task 1", "concrete verifiable task 2"],
  "groundingScore": 0.0,
  "ungroundedClaims": ["any claim in output that lacks support in previous_findings"]
}`;
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

<previous_findings>
${stage1Output}
</previous_findings>

Return your synthesis as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}${guard}`;
  }
  return `${task}

A previous exploration stage gathered these raw findings:

<previous_findings>
${stage1Output}
</previous_findings>

Your job: synthesize these findings into a decision-useful report. You do NOT need to explore further — work with the findings above.

Return your synthesis as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Rules:
- "status" is required and must be one of: ok, needs-work, blocked, exploratory.
- "summary" is required and should be one paragraph.
- "output" is required. Put the useful substance here.
- "evidence" is required. Include concrete anchors.
- "learnings" is required. Extract reusable knowledge.
- "actionItems" is required. Each item must be a concrete, verifiable task string.
- "groundingScore" is required. Rate from 0.0 to 1.0 how well each claim in "output" is supported by <previous_findings>. Be honest and strict.
- "ungroundedClaims" is required. List any claim in "output" that is not directly backed by <previous_findings>. Use an empty array if everything is grounded.
- Do NOT use markdown headings like "## Result" outside the JSON.${guard}`;
}

function countLowConfidenceFindings(findings: Stage1Findings): number {
  return findings.findings.filter((f) => f.confidence === "low").length;
}

function shouldReExplore(findings: Stage1Findings | null, verify: boolean): { should: boolean; reason?: string } {
  if (!findings) return { should: true, reason: "stage 1 produced no valid structured findings" };
  if (findings.findings.length === 0) return { should: true, reason: "stage 1 returned zero findings" };
  if (findings.findings.length < 3 && !verify) return { should: true, reason: `only ${findings.findings.length} finding(s); likely insufficient coverage` };
  const lowConfidenceCount = countLowConfidenceFindings(findings);
  if (lowConfidenceCount / findings.findings.length > 0.5) return { should: true, reason: `${Math.round((lowConfidenceCount / findings.findings.length) * 100)}% of findings are low confidence` };
  if (findings.openQuestions?.some((q) => /critical|blocker|unknown/i.test(q))) return { should: true, reason: "open questions contain critical/blocker unknowns" };
  return { should: false };
}

// ── Stage 1 structured findings ────────────────────────────

function extractJsonFromText(text: string): string | null {
  const trimmed = text.trim();
  // Markdown fenced code block
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Bare JSON object: find the first '{' and balance braces to locate the
  // matching '}'. This avoids matching from the first '{' to the last '}'
  // across prose or multiple objects.
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonObject<T>(text: string, guard: (value: unknown) => value is T): T | null {
  const jsonText = extractJsonFromText(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (!guard(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseStage1Findings(text: string): Stage1Findings | null {
  return parseJsonObject(text, isStage1Findings);
}

export function parseStage2Report(text: string): Stage2Report | null {
  return parseJsonObject(text, isStage2Report);
}

export function formatStage2Report(report: Stage2Report): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status}`);
  lines.push("");
  lines.push(report.summary);
  lines.push("");
  lines.push(`## Output`);
  lines.push(report.output);
  lines.push("");
  lines.push(`## Evidence`);
  lines.push(report.evidence);
  lines.push("");
  if (report.groundingScore !== undefined) {
    const pct = Math.round(report.groundingScore * 100);
    const icon = pct >= 80 ? "✅" : pct >= 50 ? "⚠️" : "❌";
    lines.push(`## Grounding ${icon} ${pct}%`);
    if (report.ungroundedClaims && report.ungroundedClaims.length > 0) {
      for (const claim of report.ungroundedClaims.slice(0, 10)) {
        lines.push(`- ${claim}`);
      }
    } else {
      lines.push("All claims are grounded in the exploration evidence.");
    }
    lines.push("");
  }
  lines.push(`## Learnings`);
  lines.push(report.learnings);
  if (report.actionItems.length > 0) {
    lines.push("");
    lines.push(`## Action Items`);
    for (const item of report.actionItems) {
      const clean = item.replace(/^\s*[-*]\s*/, "").trim();
      lines.push(`- [ ] ${clean}`);
    }
  }
  return lines.join("\n");
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

export function buildFileReviewPrompt(
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

  // Keep the inline report small enough that it does not blow up the CLI
  // argument list before the session-file guard has a chance to offload it.
  const MAX_REPORT_INLINE_CHARS = 12000;
  const normalizedReport = reportContent.length > MAX_REPORT_INLINE_CHARS
    ? reportContent.slice(0, MAX_REPORT_INLINE_CHARS) + `\n\n... (truncated from ${reportContent.length} chars; read the full file for complete context)`
    : reportContent;

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
${normalizedReport}
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

  // Inherited fallback — only used if stage profile doesn't provide its own.
  // Tools use !stageProfile.id as proxy (no stageProfile.tools field yet).
  if (inheritedCliArgs.fallbackModel && !stageProfile.id) {
    args.push("--model", inheritedCliArgs.fallbackModel);
  }
  if (inheritedCliArgs.fallbackThinking && !stageProfile.thinking) {
    args.push("--thinking", inheritedCliArgs.fallbackThinking);
  }

  // Tool policy: scout gets a read-only allowlist; forge/review gets no tools.
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

  // Stage profile overrides
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
  /** If true, pass --no-tools so the child process cannot modify files */
  noTools?: boolean;
  /** Tool mode passed through to buildPiArgs: scout = read-only allowlist, forge = --no-tools. */
  toolMode?: "scout" | "forge";
  /** Max wall-clock ms before the stage is force-killed. 0 = no limit. */
  stageTimeoutMs?: number;
  /**
   * If provided, skip redundant sanitization of forkSessionJsonl.
   * Useful when the same snapshot is reused across stages.
   */
  sanitizedSessionJsonl?: { jsonl: string; stripped: number };
  /** Number of retries on spawn/early-exit failures. */
  retries?: number;
  /**
   * Optional callback invoked when a JSON event line is parsed during the stage.
   * Allows callers to show live progress.
   */
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        // Exponential backoff: 1s, 2s, 4s, ...
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

async function runStageCore(opts: RunStageOptions): Promise<ForkResult> {
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
  let sessionFilePath = tmp.filePath;
  let taskArg = task;
  let exitCode = -1;

  try {
    const { command, prefixArgs } = resolvePiSpawn();

    // Test-build args to check command-line length. If the task is so large that
    // it would exceed OS spawn limits, offload the task into the session file as
    // a user message and pass a minimal task argument instead.
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

  // Determine provider/model from messages or stage profile
  if (!result.provider) result.provider = stageProfile.provider;
  if (!result.model) result.model = stageProfile.id;

  return result;
} finally {
  cleanupTempDir(tmp.dir);
}
}

// ── Main auto-fork orchestrator ──────────────────────────────

export interface RunAutoForkOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl: string;
  stage1Profile: StageProfile;
  /** Optional second scout model for verify mode. Falls back to stage1Profile if unset. */
  stage1bProfile?: StageProfile;
  stage2Profile: StageProfile;
  customExplorePrompt?: string;
  customSynthesizePrompt?: string;
  /** If true, skip stage 2 — return raw stage 1 findings only. */
  quick?: boolean;
  /** If true, run stage 1 twice and merge findings before stage 2. */
  verify?: boolean;
  /** If true, allow the child to modify files (no audit guard, stage 2 keeps tools). */
  editMode?: boolean;
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
  const { cwd, task, forkSessionSnapshotJsonl, stage1Profile, stage1bProfile,
          stage2Profile, customExplorePrompt, customSynthesizePrompt,
          quick = false, verify = false, editMode = false,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const details: AutoForkDetails = { stage1: null, stage2: null };

  // Sanitize session snapshot once and reuse across stages
  const sanitizedSnapshot = sanitizeSessionJsonl(forkSessionSnapshotJsonl);

  // ── Stage 1: Exploration with cheap model ──
  const scoutModelLabel = stage1Profile.thinking ? `${stage1Profile.provider}:${stage1Profile.id} • ${stage1Profile.thinking}` : `${stage1Profile.provider}:${stage1Profile.id}`;
  opts.onProgress?.("scout", scoutModelLabel);
  const stage1Task = buildStage1Prompt(task, customExplorePrompt, editMode);

  let stage1Result: ForkResult;
  let stage1Findings: Stage1Findings | null = null;
  const onUpdate = opts.onUpdate;

  async function runStage1Run(label: string, profile?: StageProfile): Promise<ForkResult> {
    return runStageWithRetry({
      cwd,
      task: stage1Task,
      stageLabel: label,
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: profile || stage1Profile,
      extensions,
      environment,
      offline,
      signal,
      stageTimeoutMs: 300_000,
      sanitizedSessionJsonl: sanitizedSnapshot,
      retries: 1,
      toolMode: "scout",
      onUpdate,
    });
  }

  if (verify) {
    // Self-consistency: run stage 1 twice. If stage1bProfile is configured,
    // use it for the second run to get model-diversity coverage; otherwise use
    // stage1Profile twice for independent sampling.
    const secondProfile = stage1bProfile && stage1bProfile.provider && stage1bProfile.id ? stage1bProfile : stage1Profile;
    const [runA, runB] = await Promise.all([
      runStage1Run("exploration A", stage1Profile),
      runStage1Run("exploration B", secondProfile),
    ]);

    // Combine usage from both runs into the primary stage1 result
    const combinedUsage: UsageStats = emptyUsage();
    const addUsage = (usage: UsageStats | undefined | null) => {
      if (!usage) return;
      combinedUsage.input += usage.input || 0;
      combinedUsage.output += usage.output || 0;
      combinedUsage.cacheRead += usage.cacheRead || 0;
      combinedUsage.cacheWrite += usage.cacheWrite || 0;
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

    // If findings are sparse or low-confidence, run a second exploration pass
    // automatically (unless verify mode already did two runs).
    const reExploreCheck = shouldReExplore(stage1Findings, verify);
    if (reExploreCheck.should && !verify) {
      stage1Result.stderr += `\n[cdev] ${reExploreCheck.reason}; running a second exploration pass\n`;
      const secondRun = await runStage1Run("exploration (coverage pass)");
      const secondText = getFinalAssistantText(secondRun.messages) || "";
      const secondFindings = parseStage1Findings(secondText);
      const secondValidation = secondFindings ? validateStage1Findings(secondFindings, "coverage pass") : { valid: false, reason: "coverage pass output was not valid JSON findings" };
      if (secondValidation.valid) {
        if (stage1Findings && secondFindings) {
          stage1Findings = mergeStage1Findings(stage1Findings, secondFindings);
          stage1Result.stderr += `\n[cdev] merged second pass: ${stage1Findings.findings.length} total findings\n`;
        } else if (secondFindings) {
          stage1Findings = secondFindings;
        }
        stage1Result = {
          ...secondRun,
          stderr: [stage1Result.stderr, secondRun.stderr].filter(Boolean).join("\n"),
        };
      } else {
        stage1Result.stderr += `\n[cdev] coverage pass invalid (${secondValidation.reason}); using first pass\n`;
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

  const stage2Task = buildStage2Prompt(task, stage1Text, customSynthesizePrompt, editMode);

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
      noTools: !editMode,
      toolMode: editMode ? undefined : "forge",
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
    combinedUsage.cacheRead += usage.cacheRead || 0;
    combinedUsage.cacheWrite += usage.cacheWrite || 0;
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

  // Try to parse structured stage 2 report; fall back to raw text if invalid
  const stage2Text = getFinalAssistantText(stage2Result.messages);
  const stage2Report = stage2Text ? parseStage2Report(stage2Text) : null;
  if (stage2Report) {
    finalResult.stderr += "\n[cdev] forge produced structured JSON report\n";
  } else if (stage2Text) {
    finalResult.stderr += "\n[cdev] forge output was not valid structured JSON; using raw text\n";
  }

  return { result: finalResult, details };
}

/** Format the final assistant output, preferring structured report when available. */
export function formatForkResultOutput(result: ForkResult, details: AutoForkDetails): string {
  const stage2Text = getFinalAssistantText(result.messages);
  if (!stage2Text) {
    return formatResultContent(result, details);
  }
  const report = parseStage2Report(stage2Text);
  if (report) {
    return formatStage2Report(report);
  }
  return formatResultContent(result, details);
}

/** Compute a simple line diff between two texts. */
export function computeReportDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const normalize = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("- [ ]") && !line.startsWith("- [x]"));

  const oldLines = new Set(normalize(oldText));
  const newLines = new Set(normalize(newText));

  const added = [...newLines].filter((line) => !oldLines.has(line));
  const removed = [...oldLines].filter((line) => !newLines.has(line));
  return { added, removed };
}

export function formatReportDiff(diff: { added: string[]; removed: string[] }): string {
  const lines: string[] = [];
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return "No significant changes detected vs previous report.";
  }
  if (diff.added.length > 0) {
    lines.push("### New");
    for (const line of diff.added.slice(0, 30)) lines.push(`+ ${line}`);
    if (diff.added.length > 30) lines.push(`+ ... and ${diff.added.length - 30} more`);
  }
  if (diff.removed.length > 0) {
    lines.push("");
    lines.push("### Removed / Changed");
    for (const line of diff.removed.slice(0, 30)) lines.push(`- ${line}`);
    if (diff.removed.length > 30) lines.push(`- ... and ${diff.removed.length - 30} more`);
  }
  return lines.join("\n");
}

// ── Shared review stage wrapper ────────────────────────────

interface RunReviewOptions {
  cwd: string;
  task: string;
  stageProfile: StageProfile;
  forkSessionJsonl?: string;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}

async function runReviewStage(
  opts: RunReviewOptions,
  errorContext: string,
): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, task, stageProfile, forkSessionJsonl = JSON.stringify({}) + "\n",
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  onProgress?.("forge", stageProfile.thinking ? `${stageProfile.provider}:${stageProfile.id} • ${stageProfile.thinking}` : `${stageProfile.provider}:${stageProfile.id}`);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task,
      stageLabel: "review",
      forkSessionJsonl: forkSessionJsonl,
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
      noTools: true,
      toolMode: "forge",
      stageTimeoutMs: 180_000,
      retries: 1,
      onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult(errorContext, `${errorContext} failed: ${message}`);
  }

  return { result, details: { stage1: null, stage2: result } };
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
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  const reviewTask = buildReviewPrompt(customReviewPrompt);
  return runReviewStage({
    cwd,
    task: reviewTask,
    stageProfile,
    forkSessionJsonl: forkSessionSnapshotJsonl,
    onProgress,
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  }, "Review");
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
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

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
  return runReviewStage({
    cwd,
    task: reviewTask,
    stageProfile,
    onProgress,
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  }, `File review ${filePath}`);
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
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  const reviewTask = buildDiffReviewPrompt(diffSpec, diffContent);
  return runReviewStage({
    cwd,
    task: reviewTask,
    stageProfile,
    onProgress,
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  }, `Diff review ${diffSpec}`);
}

// ── YOLO review-fix loop ───────────────────────────────────

export type ReviewVerdict = "pass" | "needs-work" | "blocked" | "unknown";

export function parseReviewVerdict(text: string): ReviewVerdict {
  const match = text.match(/## Result\b([\s\S]*?)(?=##\s|$)/i);
  if (!match) return "unknown";
  const section = match[1].toLowerCase();
  if (section.includes("needs-work") || section.includes("needs work")) return "needs-work";
  if (section.includes("blocked")) return "blocked";
  if (section.includes("pass")) return "pass";
  return "unknown";
}

export interface YoloRoundResult {
  round: number;
  review: {
    result: ForkResult;
    details: AutoForkDetails;
    reportPath: string;
    verdict: ReviewVerdict;
  };
  fix?: {
    result: ForkResult;
    details: AutoForkDetails;
    reportPath: string;
  };
}

export interface YoloLoopResult {
  initial: {
    result: ForkResult;
    details: AutoForkDetails;
    reportPath: string;
  };
  rounds: YoloRoundResult[];
  totalCost: number;
  finalVerdict: ReviewVerdict;
  finalReportPath: string;
}

export interface RunYoloLoopOptions extends Omit<RunAutoForkOptions, "onProgress" | "onUpdate"> {
  config: AutoForkConfig;
  yoloConfig: Required<Omit<YoloConfig, "reviewProfile" | "fixProfile">> & Pick<YoloConfig, "reviewProfile" | "fixProfile">;
  reviewProfile: StageProfile;
  fixProfile: StageProfile;
  customReviewPrompt?: string;
  onProgress?: (stage: "scout" | "forge" | "review" | "fix", model: string, round?: number) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
}

function buildYoloReviewSnapshot(baseSnapshot: string, reportContent: string, round: number): string {
  const task = `YOLO review-fix round ${round}. Review the following cdev report against the actual code and determine whether the reported issues have been resolved.

Report:\n${reportContent}`;
  return appendTaskToSessionJsonl(baseSnapshot, task);
}

function buildYoloFixTask(originalTask: string, reviewText: string, round: number): string {
  return `Fix the following issues from code review (round ${round}):

${reviewText}

Original task: ${originalTask}`;
}

function yoloSlug(task: string): string {
  return task
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);
}

export async function runYoloLoop(opts: RunYoloLoopOptions): Promise<YoloLoopResult> {
  const {
    cwd, task, forkSessionSnapshotJsonl, stage1Profile, stage1bProfile, stage2Profile,
    yoloConfig, reviewProfile, fixProfile, customExplorePrompt, customSynthesizePrompt, customReviewPrompt,
    extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate,
  } = opts;

  const baseSlug = yoloSlug(task);

  function addUsage(acc: UsageStats, usage: UsageStats | undefined | null): void {
    if (!usage) return;
    acc.input += usage.input || 0;
    acc.output += usage.output || 0;
    acc.cacheRead += usage.cacheRead || 0;
    acc.cacheWrite += usage.cacheWrite || 0;
    acc.cost += usage.cost || 0;
    acc.turns += usage.turns || 0;
    acc.contextTokens = Math.max(acc.contextTokens, usage.contextTokens || 0);
  }

  const totalUsage: UsageStats = emptyUsage();

  // Budget helpers for the loop
  function checkYoloBudget(spentSoFar: number, nextEstimate: number): { allowed: boolean; reason?: string } {
    const maxForkCost = opts.config.maxForkCost ?? 0;
    const maxSessionCost = opts.config.maxSessionCost ?? 0;
    if (maxForkCost > 0 && nextEstimate > maxForkCost) {
      return { allowed: false, reason: `next fork estimate ${formatCost(nextEstimate)} exceeds maxForkCost ${formatCost(maxForkCost)}` };
    }
    const sessionCost = getSessionForkCost(cwd);
    if (maxSessionCost > 0 && sessionCost + spentSoFar + nextEstimate > maxSessionCost) {
      return { allowed: false, reason: `YOLO session cost would reach ${formatCost(sessionCost + spentSoFar + nextEstimate)}, exceeding maxSessionCost ${formatCost(maxSessionCost)}` };
    }
    return { allowed: true };
  }

  // ── Initial scout + forge ──
  const initialStart = Date.now();
  const { result: initialResult, details: initialDetails } = await runAutoFork({
    cwd,
    task: withAuditGuard(task),
    forkSessionSnapshotJsonl,
    stage1Profile,
    stage1bProfile,
    stage2Profile,
    customExplorePrompt,
    customSynthesizePrompt,
    quick: false,
    verify: false,
    onProgress: (stage, model) => onProgress?.(stage, model),
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  });
  addUsage(totalUsage, initialResult.usage);

  const initialText = getFinalAssistantText(initialResult.messages) || "";
  let initialReportPath = "";
  if (initialText && !initialResult.errorMessage) {
    const { reportRelPath } = writeReportFile({
      cwd,
      fileName: `yolo-${baseSlug}-initial-${Date.now().toString(36)}.md`,
      title: "cdev YOLO initial report",
      body: initialText,
    });
    initialReportPath = reportRelPath;
    saveSession(cwd, `yolo initial: ${task}`, false, initialStart, initialDetails, initialResult);
  }

  const rounds: YoloRoundResult[] = [];
  let finalVerdict: ReviewVerdict = "unknown";
  let finalReportPath = initialReportPath;
  let latestReport = initialText;

  // ── Review-fix rounds ──
  for (let round = 1; round <= yoloConfig.maxRounds; round++) {
    if (!latestReport) break;

    const reviewEstimate = estimateForkCost({
      task: buildYoloReviewSnapshot("", latestReport, round),
      stage1Profile,
      stage2Profile: reviewProfile,
      forkSessionSnapshotJsonl,
    });
    const reviewBudget = checkYoloBudget(totalUsage.cost, reviewEstimate.cost);
    if (!reviewBudget.allowed) {
      finalVerdict = "blocked";
      rounds.push({
        round,
        review: {
          result: emptyFailedResult(task, `YOLO budget blocked before review round ${round}: ${reviewBudget.reason}`),
          details: { stage1: null, stage2: null },
          reportPath: "",
          verdict: "blocked",
        },
      });
      break;
    }

    const reviewStart = Date.now();
    const reviewSnapshot = buildYoloReviewSnapshot(forkSessionSnapshotJsonl, latestReport, round);
    const reviewModelLabel = reviewProfile.thinking
      ? `${reviewProfile.provider}:${reviewProfile.id} • ${reviewProfile.thinking}`
      : `${reviewProfile.provider}:${reviewProfile.id}`;
    onProgress?.("review", reviewModelLabel, round);

    const { result: reviewResult, details: reviewDetails } = await runCdevReview({
      cwd,
      forkSessionSnapshotJsonl: reviewSnapshot,
      stageProfile: reviewProfile,
      customReviewPrompt,
      onProgress: (_stage, model) => onProgress?.("review", model, round),
      onUpdate,
      extensions,
      environment,
      offline,
      signal,
    });
    addUsage(totalUsage, reviewResult.usage);

    const reviewText = getFinalAssistantText(reviewResult.messages) || "";
    const { reportRelPath: reviewReportPath } = writeReportFile({
      cwd,
      fileName: `yolo-${baseSlug}-round${round}-${Date.now().toString(36)}.md`,
      title: `cdev YOLO review round ${round}`,
      reviewer: reviewDetails.stage2?.model ?? "?",
      body: reviewText || "(no review output)",
    });
    finalReportPath = reviewReportPath;
    saveSession(cwd, `yolo review round ${round}: ${task}`, true, reviewStart, reviewDetails, reviewResult);

    const verdict = parseReviewVerdict(reviewText);
    finalVerdict = verdict;

    const roundResult: YoloRoundResult = {
      round,
      review: {
        result: reviewResult,
        details: reviewDetails,
        reportPath: reviewReportPath,
        verdict,
      },
    };

    if (verdict === "pass" && yoloConfig.stopOnPass) {
      rounds.push(roundResult);
      break;
    }

    if (yoloConfig.autoApply === "off") {
      rounds.push(roundResult);
      // When not auto-applying fixes, there is nothing more to do.
      break;
    }

    // ── Fix round ──
    const fixEstimate = estimateForkCost({
      task: buildYoloFixTask(task, reviewText, round),
      stage1Profile,
      stage2Profile: fixProfile,
      forkSessionSnapshotJsonl,
    });
    const fixBudget = checkYoloBudget(totalUsage.cost, fixEstimate.cost);
    if (!fixBudget.allowed) {
      roundResult.fix = {
        result: emptyFailedResult(task, `YOLO budget blocked before fix round ${round}: ${fixBudget.reason}`),
        details: { stage1: null, stage2: null },
        reportPath: "",
      };
      rounds.push(roundResult);
      finalVerdict = "blocked";
      break;
    }

    const fixStart = Date.now();
    const fixModelLabel = fixProfile.thinking
      ? `${fixProfile.provider}:${fixProfile.id} • ${fixProfile.thinking}`
      : `${fixProfile.provider}:${fixProfile.id}`;
    onProgress?.("fix", fixModelLabel, round);

    const fixTask = buildYoloFixTask(task, reviewText, round);
    const { result: fixResult, details: fixDetails } = await runAutoFork({
      cwd,
      task: fixTask,
      forkSessionSnapshotJsonl,
      stage1Profile,
      stage1bProfile,
      stage2Profile: fixProfile,
      customExplorePrompt,
      customSynthesizePrompt,
      quick: false,
      verify: false,
      editMode: true,
      onProgress: (stage, model) => onProgress?.(stage === "scout" || stage === "forge" ? stage : "fix", model, round),
      onUpdate,
      extensions,
      environment,
      offline,
      signal,
    });
    addUsage(totalUsage, fixResult.usage);

    const fixText = getFinalAssistantText(fixResult.messages) || "";
    let fixReportPath = "";
    if (fixText && !fixResult.errorMessage) {
      const { reportRelPath } = writeReportFile({
        cwd,
        fileName: `yolo-${baseSlug}-fix${round}-${Date.now().toString(36)}.md`,
        title: `cdev YOLO fix round ${round}`,
        body: fixText,
      });
      fixReportPath = reportRelPath;
      saveSession(cwd, `yolo fix round ${round}: ${task}`, false, fixStart, fixDetails, fixResult);
    }

    roundResult.fix = {
      result: fixResult,
      details: fixDetails,
      reportPath: fixReportPath,
    };
    rounds.push(roundResult);

    if (fixText) {
      latestReport = fixText;
    }
  }

  return {
    initial: {
      result: initialResult,
      details: initialDetails,
      reportPath: initialReportPath,
    },
    rounds,
    totalCost: totalUsage.cost,
    finalVerdict,
    finalReportPath,
  };
}

