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
import { buildChildEnv } from "./env.ts";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine, getForkProgressText, getResultSummaryText, getFinalAssistantText } from "./runner-events.js";
import type { StageProfile, ForkResult, UsageStats, AutoForkDetails } from "./types.js";
import { emptyUsage, emptyFailedResult } from "./types.js";

const SIGKILL_TIMEOUT_MS = 5000;

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

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Prompts ────────────────────────────────────────────────

function buildStage1Prompt(task: string, customPrompt?: string): string {
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

Do NOT write a report. Return raw findings only.`;
  }
  return `${task}

You are in EXPLORATION MODE. Your job is to gather information, not to write a final report.

Instructions:
- Explore thoroughly using available tools (read, bash, ls, grep, etc.)
- Gather concrete evidence: file contents, command outputs, config values
- Return raw, unfiltered findings
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings"
- Do NOT write a decision-useful report
- Just return what you found — raw data, observations, and preliminary notes

After exploring, simply return your findings as plain text.`;
}

function buildStage2Prompt(task: string, stage1Output: string, customPrompt?: string): string {
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

<previous_findings>
${stage1Output}
</previous_findings>`;
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
- Action Items should be concrete, verifiable tasks the agent can check off`;
}

// ── Review mode prompts ────────────────────────────────────

function buildReviewPrompt(customPrompt?: string): string {
  if (customPrompt) return customPrompt;
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

Be direct. Flag real problems loudly. Don't praise trivial things.`;
}

function buildFileReviewPrompt(
  filePath: string,
  reportContent: string,
  referencedFiles: Record<string, string>,
): string {
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
</actual-files>`;
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
</diff>`;
}

// ── Stage runner ────────────────────────────────────────────

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function buildPiArgs(
  task: string,
  forkSessionPath: string,
  extensions: string[] | null,
  stageProfile: StageProfile,
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

  if (inheritedCliArgs.fallbackModel && inheritedCliArgs.fallbackModel !== stageProfile.id) {
    // Don't use fallback if we have a stage profile
  } else if (inheritedCliArgs.fallbackModel) {
    args.push("--model", inheritedCliArgs.fallbackModel);
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
}

async function runStage(opts: RunStageOptions): Promise<ForkResult> {
  const { cwd, task, stageLabel, forkSessionJsonl, stageProfile, extensions,
          environment, offline, signal } = opts;

  const result: ForkResult = {
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };

  const tmp = writeTempSessionJsonl(forkSessionJsonl);
  const piArgs = buildPiArgs(task, tmp.filePath, extensions, stageProfile);

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
    let didClose = false;
    let settled = false;
    let abortHandler: (() => void) | undefined;

    const flushLine = (line: string) => {
      if (processPiJsonLine(line, result)) { /* progress parsed */ }
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

    proc.on("close", (code) => {
      didClose = true;
      if (buffer.trim()) flushLine(buffer);
      if (!settled) { settled = true; resolve(code ?? 0); }
    });

    proc.on("error", (err) => {
      if (!settled) {
        if (!result.stderr.trim()) result.stderr = err.message;
        settled = true;
        resolve(1);
      }
    });

    if (signal) {
      abortHandler = () => {
        if (!settled) {
          // Try to kill on abort
          if (proc.pid) {
            try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          }
        }
      };
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
  /** Called when a stage starts. Lets the caller show progress. */
  onProgress?: (stage: "scout" | "forge", model: string) => void;
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
          quick = false,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const details: AutoForkDetails = { stage1: null, stage2: null };

  // ── Stage 1: Exploration with cheap model ──
  opts.onProgress?.("scout", stage1Profile.id);
  const stage1Task = buildStage1Prompt(task, customExplorePrompt);

  let stage1Result: ForkResult;
  try {
    stage1Result = await runStage({
      cwd,
      task: stage1Task,
      stageLabel: "exploration",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: stage1Profile,
      extensions,
      environment,
      offline,
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stage1Result = emptyFailedResult(task, `Stage 1 (exploration) failed: ${message}`);
  }
  details.stage1 = stage1Result;

  if (stage1Result.exitCode > 0 && !getFinalAssistantText(stage1Result.messages)) {
    // Stage 1 failed with no output — return the error
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
    return {
      result: {
        ...stage1Result,
        task,
        stopReason: "quick",
      },
      details,
    };
  }

  // ── Stage 2: Synthesis with powerful model ──
  opts.onProgress?.("forge", stage2Profile.id);
  const stage1Text = getFinalAssistantText(stage1Result.messages) ||
                     stage1Result.stderr ||
                     "(no output from exploration stage)";

  const stage2Task = buildStage2Prompt(task, stage1Text, customSynthesizePrompt);

  let stage2Result: ForkResult;
  try {
    stage2Result = await runStage({
      cwd,
      task: stage2Task,
      stageLabel: "synthesis",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: stage2Profile,
      extensions,
      environment,
      offline,
      signal,
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
    stderr: stage2Result.stderr,
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
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, forkSessionSnapshotJsonl, stageProfile,
          customReviewPrompt,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const reviewTask = buildReviewPrompt(customReviewPrompt);
  opts.onProgress?.("forge", stageProfile.id);

  let result: ForkResult;
  try {
    result = await runStage({
      cwd,
      task: reviewTask,
      stageLabel: "review",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
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
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, filePath, fileContent, stageProfile,
          extensions = null, environment = {}, offline = true, signal } = opts;

  // Extract file paths referenced in the report (Evidence section, backticks, etc.)
  const referencedFiles: Record<string, string> = {};
  const pathPatterns = [
    /\b([\w.\-\/]+\.[a-z]{2,6})\b/gi,           // file.ext
    /`([^`]*\.[a-z]{2,6})`/gi,                       // `path/to/file.ts`
    /(?:File|Path|file|path):\s*([\w.\-\/]+\.[a-z]{2,6})/gi,  // File: path/to/file.ts
  ];
  const seen = new Set<string>();
  for (const pattern of pathPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fileContent)) !== null) {
      const candidate = match[1].replace(/^[.\/\\]+/, ""); // strip leading ./ or .\
      if (candidate && !seen.has(candidate) && candidate.length < 200) {
        seen.add(candidate);
        const fullPath = path.join(cwd, candidate);
        if (fs.existsSync(fullPath)) {
          try {
            referencedFiles[candidate] = fs.readFileSync(fullPath, "utf-8");
          } catch { /* skip unreadable files */ }
        }
      }
    }
  }

  const reviewTask = buildFileReviewPrompt(filePath, fileContent, referencedFiles);
  opts.onProgress?.("forge", stageProfile.id);

  let result: ForkResult;
  try {
    result = await runStage({
      cwd,
      task: reviewTask,
      stageLabel: "review",
      forkSessionJsonl: JSON.stringify({}) + "\n",
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
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
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, diffSpec, diffContent, stageProfile,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const reviewTask = buildDiffReviewPrompt(diffSpec, diffContent);
  opts.onProgress?.("forge", stageProfile.id);

  let result: ForkResult;
  try {
    result = await runStage({
      cwd,
      task: reviewTask,
      stageLabel: "review",
      forkSessionJsonl: JSON.stringify({}) + "\n",
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
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
