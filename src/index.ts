/**
 * pi-chain-dev Extension
 *
 * Provides tool: cdev({ task: "..." })
 * Provides command: /cdev <task>
 * Provides command: /cdev-model
 *
 * Two-stage fork:
 *   Scout (cheap model): raw exploration findings.
 *   Forge (powerful model): structured report.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, type AutoForkConfig } from "./config.js";
import { runAutoFork, runCdevReview, runFileReview, runDiffReview } from "./runner.js";
import { getResultSummaryText, getFinalAssistantText } from "./runner-events.js";
import type { AutoForkDetails, ForkResult, StageProfile } from "./types.js";
import { emptyFailedResult } from "./types.js";
import { scanProject, formatScanReport } from "./scan.js";
import { saveSession, listSessions, getSession, formatHistory, formatSessionRecord, purgeOldSessions } from "./history.js";
import {
  indexFindings,
  loadMemory,
  formatMemoryTopics,
  formatTopicDetail,
  memoryClear,
  memoryForget,
  memoryGetTopic,
  memoryTopicCount,
  getErrorCount,
  clearErrorLog,
} from "./memory.js";
import { renderCall, renderResult } from "./render.js";
import { bg } from "./theme-utils.js";

// ── Constants ──────────────────────────────────────────────
/** Regex to detect "check only", "don't change", etc. in user task text */
const AUDIT_ONLY_RE = /\b(check|audit|look|inspect|analyze)\s+only\b|\bdon'?t\s+(change|implement|modify|write|edit|touch)\b|\bno\s+(changes?|implementation|modification)\b|\bjust\s+(check|look|audit|review|inspect)\b/i;

const AutoForkParams = Type.Object({
  task: Type.Optional(Type.String({
    description:
      "The task for the fork to complete. Specify what to do and where the fork's decision authority ends — it will surface ambiguities back to you rather than resolve them on your behalf.",
  })),
  review: Type.Optional(Type.Boolean({
    description:
      "If true, run review-only mode: skip scout (exploration) and go straight to forge (powerful model) for code review. Use for reviewing recent changes, finding bugs, or second opinions.",
  })),

  quick: Type.Optional(Type.Boolean({
    description:
      "If true, run scout only (exploration) and return raw findings. Skip the forge (synthesis). Use for quick follow-up file tracing, grep-style lookups, or narrow questions.",
  })),
  auditOnly: Type.Optional(Type.Boolean({
    description:
      "If true, append a hard guard instructing the fork model NOT to implement or modify any code — only report findings and suggestions.",
  })),
  recall: Type.Optional(Type.String({
    description:
      "Retrieve past cdev fork findings from project memory for a given topic (e.g. 'auth', 'payment'). No fork runs — returns cached knowledge. Leave empty to list all known topics. Use before exploring a topic that may have been explored before.",
  })),
  reviewFile: Type.Optional(Type.String({
    description:
      "If review is true, you can set this to a file path (relative to cwd) to review that file's content instead of the current session. Use for reviewing saved cdev reports or any artifact.",
  })),
  diffSpec: Type.Optional(Type.String({
    description:
      "If review is true, provide a git or SVN revision range to review the diff (e.g. 'HEAD~3..HEAD', 'main..feature', 'r1234:1235'). Runs git diff or svn diff and sends the output to the review model.",
  })),
});

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

function buildSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function resolveStageProfiles(
  config: AutoForkConfig,
): { stage1: StageProfile; stage2: StageProfile; warning?: string } {
  // Use configured stage1/stage2 directly
  const stage1 = config.stage1;
  const stage2 = config.stage2;

  if (!stage1.provider || !stage1.id || !stage2.provider || !stage2.id) {
    return {
      stage1: { provider: "", id: "", thinking: "minimal" },
      stage2: { provider: "", id: "", thinking: "xhigh" },
      warning: "cdev is not configured. Add 'pi-chain-dev' to settings.json with stage1 and stage2 profiles.\n\nExample:\n{\n  \"pi-chain-dev\": {\n    \"stage1\": { \"provider\": \"openai-codex\", \"id\": \"gpt-5-mini\", \"thinking\": \"minimal\" },\n    \"stage2\": { \"provider\": \"opencode-go\", \"id\": \"deepseek-v4-flash\", \"thinking\": \"xhigh\" }\n  }\n}",
    };
  }

  return { stage1, stage2 };
}

function formatResultContent(result: ForkResult, details: AutoForkDetails): string {
  const finalText = getFinalAssistantText(result.messages);

  if (result.errorMessage && !finalText) {
    const scoutInfo = details.stage1
      ? ` | Scout: ${details.stage1.model || "?"} (exit ${details.stage1.exitCode})`
      : "";
    const forgeInfo = details.stage2
      ? ` | Forge: ${details.stage2.model || "?"} (exit ${details.stage2.exitCode})`
      : "";
    const costInfo = (result.usage?.cost ?? 0) > 0 ? ` — cost: $${(result.usage?.cost ?? 0).toFixed(4)}` : "";
    return `cdev failed: ${result.errorMessage}${scoutInfo}${forgeInfo}${costInfo}`;
  }

  const summary = finalText || getResultSummaryText(result);

  // Prepend stage info
  let header = "";
  const isReview = details.stage1 === null && details.stage2 !== null;
  if (isReview) {
    header += `Review ran with ${details.stage2?.model || "?"}: ${details.stage2?.exitCode ?? "?"} exit\n\n`;
  } else {
    if (details.stage1) {
      header += `Scout (exploration) ran with ${details.stage1.model || "?"}: ${details.stage1.exitCode} exit\n`;
    }
    if (details.stage2) {
      header += `Forge (synthesis) ran with ${details.stage2.model || "?"}: ${details.stage2.exitCode} exit\n`;
    }
    if (header) header += "\n";
  }

  return header + summary;
}

export default function (pi: ExtensionAPI) {
  // ── Footer cost status ──────────────────────────────────
  const FORK_COST_STATUS_KEY = "cdev-cost";

  /** Default signature shown in /cdev status. Overridden by config.signature. */
  const DEFAULT_SIGNATURE = "whatley.xyz";

  function resolveSignature(config: AutoForkConfig): string {
    return config.signature || DEFAULT_SIGNATURE;
  }

  /** Append an error record to .pi/cdev/errors.jsonl */
  function logError(cwd: string, context: string, err: unknown): void {
    try {
      const cdevDir = join(cwd, ".pi", "cdev");
      mkdirSync(cdevDir, { recursive: true });
      const record = JSON.stringify({
        ts: new Date().toISOString(),
        context,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      appendFileSync(join(cdevDir, "errors.jsonl"), record + "\n", "utf-8");
    } catch {
      // fail silently — can't log the log error
    }
  }

  function updateForkCostStatus(ctx: ExtensionContext): void {
    const config = loadConfig(ctx.cwd);
    if (!config.costFooter) {
      ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
      return;
    }

    // Aggregate cost from cdev tool results
    const entries = ctx.sessionManager.getEntries();
    let totalCost = 0;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message") {
        const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined;
        if (message?.role === "toolResult" && message?.toolName === "cdev") {
          const details = message.details as AutoForkDetails | undefined;
          if (details?.stage1?.usage?.cost) totalCost += details.stage1.usage.cost;
          if (details?.stage2?.usage?.cost) totalCost += details.stage2.usage.cost;
        }
      }
    }

    const segments: string[] = [];
    if (config.auto) segments.push("⚡");
    segments.push("cdev");
    if (totalCost > 0) segments.push(`$${totalCost.toFixed(4)}`);
    if (config.promptsEnabled && (config.prompts?.explore || config.prompts?.review)) segments.push("📋");
    // Fold memory count into footer
    if (config.memory) {
      const topicCount = memoryTopicCount(ctx.cwd);
      if (topicCount > 0) segments.push(`🧠${topicCount}`);
    }

    if (segments.length <= 1) {
      ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
      ctx.ui.setStatus("cdev-memory", undefined);
      return;
    }

    ctx.ui.setStatus(FORK_COST_STATUS_KEY, ctx.ui.theme.fg("dim", segments.join(" | ")));
    ctx.ui.setStatus("cdev-memory", undefined); // folded, not separate
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      updateForkCostStatus(ctx);
      const config = loadConfig(ctx.cwd);

      // Purge old sessions
      const purged = purgeOldSessions(ctx.cwd, 7);
      if (purged > 0) {
        ctx.ui.notify(`Purged ${purged} old cdev session${purged > 1 ? "s" : ""} (>7 days)`, "info");
      }
      // Purge old reports (>7 days)
      let purgedReports = 0;
      const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
      if (existsSync(reportsDir)) {
        const now = Date.now();
        const week = 7 * 24 * 60 * 60 * 1000;
        for (const entry of readdirSync(reportsDir)) {
          if (!entry.endsWith(".md")) continue;
          if (now - statSync(join(reportsDir, entry)).mtimeMs > week) {
            unlinkSync(join(reportsDir, entry));
            purgedReports++;
          }
        }
      }
      if (purgedReports > 0) {
        ctx.ui.notify(`Purged ${purgedReports} old cdev report${purgedReports > 1 ? "s" : ""} (>7 days)`, "info");
      }

      // Warn if .pi/ is not gitignored / svn-ignored (one-time per project)
      // Re-check if sentinel exists but fix was never applied
      const sentinelPath = join(ctx.cwd, ".pi", ".cdev-ignore-ok");
      if (!existsSync(sentinelPath)) {
        let warned = false;
        // Git: check if repo exists, then whether .pi/ is ignored
        if (existsSync(join(ctx.cwd, ".git"))) {
          const gitignorePath = join(ctx.cwd, ".gitignore");
          if (!existsSync(gitignorePath)) {
            // No .gitignore at all — create one with .pi/
            try {
              writeFileSync(gitignorePath, ".pi/\n", "utf-8");
              ctx.ui.notify("Created .gitignore with .pi/ — cdev data now excluded from version control.", "info");
            } catch { /* read-only fs */ }
            warned = true;
          } else {
            const gi = readFileSync(gitignorePath, "utf-8");
            if (!(/^\.pi[/\s]|^\.pi$/m.test(gi) || gi.includes(".pi/"))) {
              ctx.ui.notify(".pi/ is not gitignored — cdev data may leak to version control. Add '.pi/' to .gitignore.", "warn");
              warned = true;
            }
          }
        }
        // SVN: check svn:ignore property if .svn/ exists
        if (!warned && existsSync(join(ctx.cwd, ".svn"))) {
          try {
            const result = spawnSync("svn", ["propget", "svn:ignore", "."], { cwd: ctx.cwd, encoding: "utf-8", timeout: 5000 });
            const svnIgnore = (result.stdout || "").trim();
            if (!svnIgnore.split(/[\r\n]+/).some((line: string) => line.trim() === ".pi")) {
              ctx.ui.notify(".pi/ is not in svn:ignore — cdev data may leak to version control. Run: svn propset svn:ignore '.pi' .", "warn");
              warned = true;
            }
          } catch { /* svn not available */ }
        }
        // Always mark checked to avoid re-scanning every session start
        try { mkdirSync(join(ctx.cwd, ".pi"), { recursive: true }); writeFileSync(sentinelPath, "", "utf-8"); } catch {}
      }
    } catch (err) {
      logError(ctx.cwd, "session_start", err);
    }
  });
  pi.on("turn_end", async (_event, ctx) => {
    try { updateForkCostStatus(ctx); } catch { /* best effort */ }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
      ctx.ui.setStatus("cdev-memory", undefined);
      ctx.ui.setWidget("cdev-progress", undefined);
    } catch { /* best effort */ }
  });
  // Auto-trigger counter: inject steer every 3 turns when enabled
  let autoTurnCounter = 0;
  function updateAutoStatus(ctx: ExtensionContext): void {
    updateForkCostStatus(ctx);
  }
  function resetAutoTurnCounter(): void {
    autoTurnCounter = 0;
  }
  pi.on("turn_start", async (_event, ctx) => {
    updateAutoStatus(ctx);
    const config = loadConfig(ctx.cwd);
    if (config.auto) {
      autoTurnCounter++;
      if (autoTurnCounter % 3 === 0) {
        pi.sendUserMessage(
          "auto-mode: Consider using the cdev tool for any exploration or research parts of this task.",
          { deliverAs: "steer" },
        );
      }
    }
  });

  function updatePromptsStatus(ctx: ExtensionContext): void {
    updateForkCostStatus(ctx);
  }

  // ── Register cdev tool ──────────────────────────────────
  pi.registerTool({
    name: "cdev",
    label: "Chain Dev",
    description:
      "Two-stage development fork: first a cheap model (scout) explores and gathers evidence, then a powerful model (forge) synthesizes a structured report. Set review=true to skip exploration and run code review with the powerful model only. Set quick=true for scout only (raw findings, no forge). Set recall=<topic> to retrieve past fork findings from project memory (no fork runs). Set reviewFile=<path> with review=true to review a specific file/artifact instead of the session. Set diffSpec=<range> to review a git/svn diff (e.g. 'HEAD~3..HEAD'). When cdev auto mode is enabled, proactively use this tool for exploration tasks.",
    promptSnippet: "Two-stage fork: scout (cheap) explores → forge (powerful) writes (or scout only with quick:true). Use recall to retrieve past findings.",
    promptGuidelines: [
      "Use cdev for any task requiring more than 3-4 file reads — cheaper than parent model reading files one-by-one.",
      "Use cdev with recall=<topic> to check project memory before exploring a topic that may have been explored before. This costs $0 and avoids duplicate work.",
      "Use cdev with recall='' (empty string) to list all known topics when starting work in a project.",
      "Use cdev with review:true after significant code changes to get a second opinion from a different model.",
      "Use cdev with review:true and reviewFile=<path> to review a saved cdev report or any artifact file.",
      "Use cdev with review:true and diffSpec=<range> to review changes between git or SVN revisions.",
      "After implementing findings from a cdev report, update the report file to check off Action Items and add implementation notes. Then suggest the user run /cdev review <reportPath> to verify the changes.",
      "When a /cdev review file appends findings, address the new Action Items and check them off in the report.",
      "Use cdev with quick:true for follow-up file tracing, grep-style lookups, or when raw findings suffice.",
      "Prefer cdev over bash/grep when you need to understand file relationships, not just find text matches.",
      "Tell cdev to surface ambiguities back to you — don't resolve them in the fork.",
      "Use cdev with auditOnly=true when asked to review/check only — prevents the fork from modifying code.",
    ],
    parameters: AutoForkParams,
    renderCall,
    renderResult,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
      const config = loadConfig(ctx.cwd);

      // Audit guard helper
      const AUDIT_GUARD = "\n\n⚠️ AUDIT ONLY — DO NOT implement, modify, or write any code. Only report findings and suggestions.";
      const withAuditGuard = (t: string): string =>
        (params.auditOnly || AUDIT_ONLY_RE.test(t)) ? t + AUDIT_GUARD : t;

      // Themed background helper (graceful fallback to ANSI if token missing)
      const themedBg = (token: string, text: string): string => {
        return bg(token, text, ctx.ui.theme, config.themed);
      };

      // ── Recall mode (no fork, just memory lookup) ──
      if (params.recall !== undefined) {
        if (!config.memory) {
          return {
            content: [{ type: "text" as const, text: "cdev memory is disabled. Enable with /cdev memory on." }],
            details: { stage1: null, stage2: null },
          };
        }
        if (params.recall) {
          const entry = memoryGetTopic(ctx.cwd, params.recall);
          if (entry) {
            const detail = formatTopicDetail(entry, ctx.cwd);
            return {
              content: [{ type: "text" as const, text: `🧠 cdev memory hit: ${params.recall}\n\n${detail}` }],
              details: { stage1: null, stage2: null },
            };
          }
          return {
            content: [{ type: "text" as const, text: `🧠 cdev memory miss: no findings for "${params.recall}".` }],
            details: { stage1: null, stage2: null },
          };
        }
        // Empty string = list all topics
        const memory = loadMemory(ctx.cwd);
        const listing = formatMemoryTopics(memory);
        return {
          content: [{ type: "text" as const, text: `🧠 cdev memory\n\n${listing}` }],
          details: { stage1: null, stage2: null },
        };
      }

      // ── Review mode ──
      if (params.review) {
        // Task is optional for review — use placeholder if absent
        const reviewTask = params.task || "review";
        const reviewProfile = config.review ?? config.stage2;
        if (!reviewProfile.provider || !reviewProfile.id) {
          return {
            content: [{ type: "text" as const, text: "cdev review error: Review model not configured. Use /cdev-model." }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }

        // File review: review a specific artifact file
        if (typeof params.reviewFile === "string" && params.reviewFile.trim()) {
          const arg = params.reviewFile.trim();
          const filePath = isAbsolute(arg) ? arg : join(ctx.cwd, arg);
          if (!existsSync(filePath)) {
            return {
              content: [{ type: "text" as const, text: `cdev review error: File not found: ${filePath}` }],
              details: { stage1: null, stage2: null },
              isError: true,
            };
          }
          const fileContent = readFileSync(filePath, "utf-8");
          const onProgress = (stage: string, model: string) => {
            const icon = stage === "scout" ? "🔍" : "⚒️";
            const label = stage === "scout" ? "Scout" : "Forge";
            ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} reviewing ${params.reviewFile}…  (${model})`)]);
          };
          onProgress("forge", reviewProfile.id);
          const startTime = Date.now();
          const { result, details } = await runFileReview({
            cwd: ctx.cwd,
            filePath: params.reviewFile,
            fileContent,
            stageProfile: reviewProfile,
            onProgress,
            extensions: config.extensions,
            environment: config.environment,
            offline: config.offline,
            signal,
          });
          ctx.ui.setWidget("cdev-progress", undefined);

          // Append review feedback to the report file
          const reviewText = getFinalAssistantText(result.messages);
          const reviewDate = new Date().toISOString().split("T")[0];
          let reportRelPath = params.reviewFile; // the file being reviewed IS the report
          if (reviewText && !result.errorMessage) {
            const appendText = `\n\n---\n\n## Review (${reviewDate})\n\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`;
            try {
              appendFileSync(filePath, appendText, "utf-8");
            } catch { /* disk full etc. */ }

            // Also save a standalone review report for discoverability
            const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
            try {
              mkdirSync(reportsDir, { recursive: true });
              const reviewSlug = `review-${(typeof params.reviewFile === "string" ? params.reviewFile : "file").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}.md`;
              const standalonePath = join(reportsDir, reviewSlug);
              reportRelPath = `.pi/cdev/reports/${reviewSlug}`;
              writeFileSync(standalonePath, `# Review: ${params.reviewFile}\n\n**Date:** ${reviewDate}\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`, "utf-8");
            } catch { /* disk full */ }
          }

          saveSession(ctx.cwd, `review ${params.reviewFile}`, true, startTime, details, result);
          if (result.errorMessage) {
            logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
          }
          if (config.memory) {
            indexFindings({
              task: `review ${params.reviewFile}`,
              resultText: getFinalAssistantText(result.messages) || "",
              stage2Model: reviewProfile.id,
              isReview: true,
              quick: false,
              cost: (result.usage?.cost ?? 0),
              cwd: ctx.cwd,
            });
          }
          const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);

          // Build result text with explicit action instructions for the agent
          const reviewOutput = formatResultContent(result, details);
          const hasIssues = reviewText && (
            reviewText.includes("❌ missing") ||
            reviewText.includes("⚠️ partial") ||
            reviewText.includes("## Bugs Found") ||
            reviewText.includes("## Gaps") ||
            reviewText.includes("needs-work") ||
            reviewText.includes("## Issues Found") ||
            reviewText.includes("# Issues") ||
            isError
          );
          const actionNote = hasIssues
            ? `\n\n---\n⚠️  Review found issues. Read the updated report at ${params.reviewFile}\nand address the new Action Items in the ## Review section.\n📄 Standalone review: ${reportRelPath}\nCheck them off in the report file when done.`
            : `\n\n---\n✅ Review passed. Report updated at ${params.reviewFile}\n📄 Standalone review: ${reportRelPath}`;

          return {
            content: [{ type: "text" as const, text: reviewOutput + actionNote }],
            details,
            isError,
          };
        }

        // Diff review: review changes between revisions
        if (typeof params.diffSpec === "string" && params.diffSpec.trim()) {
          const diffSpec = params.diffSpec.trim();

          // Run git diff or svn diff (spawnSync, no shell)
          let diffContent: string;
          try {
            const gitResult = spawnSync("git", ["diff", diffSpec], { cwd: ctx.cwd, maxBuffer: 2 * 1024 * 1024, encoding: "utf-8" });
            if (gitResult.error || gitResult.status !== 0) {
              // Git failed — try SVN
              const gitErrMsg = gitResult.error
                ? `git not available: ${gitResult.error.message}`
                : `git exited ${gitResult.status}: ${(gitResult.stderr || "").trim().slice(0, 200)}`;
              const svnResult = spawnSync("svn", ["diff", "-r", diffSpec], { cwd: ctx.cwd, maxBuffer: 2 * 1024 * 1024, encoding: "utf-8" });
              if (svnResult.error || svnResult.status !== 0) {
                const svnErrMsg = svnResult.error
                  ? `svn not available: ${svnResult.error.message}`
                  : `svn exited ${svnResult.status}: ${(svnResult.stderr || "").trim().slice(0, 200)}`;
                const details = [gitErrMsg, svnErrMsg].filter(Boolean).join("; ");
                throw new Error(details || "both git and svn failed");
              }
              diffContent = svnResult.stdout || "";
            } else {
              diffContent = gitResult.stdout || "";
            }
            if (!diffContent.trim()) {
              return {
                content: [{ type: "text" as const, text: `cdev review error: Diff '${diffSpec}' produced no output. Check the revision range.` }],
                details: { stage1: null, stage2: null },
                isError: true,
              };
            }
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `cdev review error: Failed to run diff for '${diffSpec}': ${err instanceof Error ? err.message : String(err)}` }],
              details: { stage1: null, stage2: null },
              isError: true,
            };
          }

          const onProgress = (stage: string, model: string) => {
            const icon = stage === "scout" ? "🔍" : "⚒️";
            const label = stage === "scout" ? "Scout" : "Forge";
            ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} reviewing diff ${diffSpec}…  (${model})`)]);
          };
          onProgress("forge", reviewProfile.id);
          const startTime = Date.now();
          const { result, details } = await runDiffReview({
            cwd: ctx.cwd,
            diffSpec,
            diffContent,
            stageProfile: reviewProfile,
            onProgress,
            extensions: config.extensions,
            environment: config.environment,
            offline: config.offline,
            signal,
          });
          ctx.ui.setWidget("cdev-progress", undefined);

          // Save diff review as a report
          const diffSlug = diffSpec.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 50);
          const ts = Date.now().toString(36);
          const reportFileName = `diff-${diffSlug}-${ts}.md`;
          const reviewText = getFinalAssistantText(result.messages);
          const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
          mkdirSync(reportsDir, { recursive: true });
          const reportPath = join(reportsDir, reportFileName);
          const reportRelPath = `.pi/cdev/reports/${reportFileName}`;
          if (reviewText && !result.errorMessage) {
            try {
              writeFileSync(reportPath, `# Diff Review: ${diffSpec}\n\n**Date:** ${new Date().toISOString().split("T")[0]}\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`, "utf-8");
            } catch { /* disk full */ }
          }

          saveSession(ctx.cwd, `review diff ${diffSpec}`, true, startTime, details, result);
          if (result.errorMessage) {
            logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
          }
          if (config.memory) {
            indexFindings({
              task: `review diff ${diffSpec}`,
              resultText: reviewText || "",
              stage2Model: reviewProfile.id,
              isReview: true,
              quick: false,
              cost: (result.usage?.cost ?? 0),
              cwd: ctx.cwd,
            });
          }
          const isError = result.exitCode > 0 && !reviewText;
          const reviewOutput = formatResultContent(result, details);
          const actionNote = isError
            ? `\n\n---\n⚠️ Diff review found issues. Report saved at ${reportRelPath}`
            : `\n\n---\n✅ Diff review complete. Report saved at ${reportRelPath}`;

          return {
            content: [{ type: "text" as const, text: reviewOutput + actionNote }],
            details,
            isError,
          };
        }

        // Session review: review the current session
        const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
        if (!snapshot) {
          return {
            content: [{ type: "text" as const, text: "cdev review error: Cannot snapshot session." }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        const onProgress = (stage: string, model: string) => {
          const icon = stage === "scout" ? "🔍" : "⚒️";
          const label = stage === "scout" ? "Scout" : "Forge";
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} reviewing…  (${model})`)]);
        };
        onProgress("forge", reviewProfile.id);
        const startTime = Date.now();
        const { result, details } = await runCdevReview({
          cwd: ctx.cwd,
          forkSessionSnapshotJsonl: snapshot,
          stageProfile: reviewProfile,
          customReviewPrompt: config.promptsEnabled ? config.prompts?.review : undefined,
          onProgress,
          extensions: config.extensions,
          environment: config.environment,
          offline: config.offline,
          signal,
        });
        ctx.ui.setWidget("cdev-progress", undefined);

        // Save standalone review report
        const reviewText = getFinalAssistantText(result.messages);
        let reviewReportPath = "";
        if (reviewText && !result.errorMessage) {
          try {
            const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
            mkdirSync(reportsDir, { recursive: true });
            const reviewSlug = `session-review-${Date.now().toString(36)}.md`;
            const standalonePath = join(reportsDir, reviewSlug);
            reviewReportPath = `.pi/cdev/reports/${reviewSlug}`;
            writeFileSync(standalonePath, `# Session Review\n\n**Date:** ${new Date().toISOString().split("T")[0]}\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`, "utf-8");
          } catch { /* disk full */ }
        }

        saveSession(ctx.cwd, reviewTask, true, startTime, details, result);
        if (result.errorMessage) {
          logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        }
        if (config.memory) {
          indexFindings({
            task: reviewTask,
            resultText: getFinalAssistantText(result.messages) || "",
            stage2Model: reviewProfile.id,
            isReview: true,
            quick: false,
            cost: (result.usage?.cost ?? 0),
            cwd: ctx.cwd,
          });
        }
        const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);
        const suffix = reviewReportPath ? `\n\n---\n📄 Review report saved: ${reviewReportPath}` : "";
        return {
          content: [{ type: "text" as const, text: formatResultContent(result, details) + suffix }],
          details,
          isError,
        };
      }

      // ── Full two-stage mode ──
      if (!params.task) {
        return {
          content: [{ type: "text" as const, text: "cdev error: task is required for fork mode." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }
      const profiles = resolveStageProfiles(config);

      if (profiles.warning) {
        const result = emptyFailedResult(params.task, profiles.warning);
        return {
          content: [{ type: "text" as const, text: `cdev error: ${profiles.warning}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
      if (!snapshot) {
        const result = emptyFailedResult(
          params.task,
          "Cannot cdev: failed to snapshot current session context.",
        );
        return {
          content: [{ type: "text" as const, text: `cdev error: ${result.errorMessage}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const quick = params.quick ?? false;
      const onProgress = (stage: string, model: string) => {
        if (stage === "scout") {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔍 Scout exploring…  (${model})`)]);
        } else {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge synthesizing…  (${model})`)]);
        }
      };
      const modelStr = (p: typeof profiles.stage1) => p.thinking ? `${p.provider}:${p.id} • ${p.thinking}` : `${p.provider}:${p.id}`;
      onProgress("scout", modelStr(profiles.stage1));
      const startTime = Date.now();
      const { result, details } = await runAutoFork({
        cwd: ctx.cwd,
        task: withAuditGuard(params.task),
        forkSessionSnapshotJsonl: snapshot,
        stage1Profile: profiles.stage1,
        stage2Profile: profiles.stage2,
        customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
        customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
        quick,
        onProgress,
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal,
      });
      ctx.ui.setWidget("cdev-progress", undefined);

      saveSession(ctx.cwd, params.task, false, startTime, details, result);

      // Save forge report as shareable artifact (timestamped slug to avoid collisions)
      const slugBase = params.task
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 60);
      const ts = Date.now().toString(36);
      const slug = `${slugBase}-${ts}`;
      let reportRelPath = "";
      if (!quick && details.stage2 && !result.errorMessage) {
        const reportText = getFinalAssistantText(result.messages);
        if (reportText) {
          const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
          try {
            mkdirSync(reportsDir, { recursive: true });
            const reportPath = join(reportsDir, `${slug}.md`);
            reportRelPath = `.pi/cdev/reports/${slug}.md`;
            writeFileSync(reportPath, `# cdev report

**Task:** ${params.task}
**Scout:** ${details.stage1?.model ?? "?"}
**Forge:** ${details.stage2?.model ?? "?"}
**Date:** ${new Date().toISOString().split("T")[0]}

---

${reportText}
`, "utf-8");
          } catch { /* disk full — report lost, but fork result still valid */ }
        }
      }
      if (result.errorMessage) {
        logError(ctx.cwd, "full-mode", new Error(result.errorMessage));
      }
      if (config.memory) {
        indexFindings({
          task: params.task,
          resultText: getFinalAssistantText(result.messages) || "",
          stage1Model: config.stage1.id,
          stage2Model: params.quick ? undefined : config.stage2.id,
          isReview: false,
          quick: params.quick ?? false,
          cost: (result.usage?.cost ?? 0),
          cwd: ctx.cwd,
        });
      }

      const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);

      const resultText = formatResultContent(result, details);
      const reportNote = reportRelPath
        ? `\n\n---\n📄 Report saved: ${reportRelPath}\nAfter implementing findings, update this file to track what was done (check off items, add notes). Use /cdev review ${reportRelPath} to get a second opinion.`
        : "";

      return {
        content: [{ type: "text" as const, text: resultText + reportNote }],
        details,
        isError,
      };
      } catch (err) {
        ctx.ui.setWidget("cdev-progress", undefined);
        logError(ctx.cwd, "tool", err);
        return {
          content: [{ type: "text" as const, text: `cdev error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }
    },
  });

  // ── Register /cdev command ───────────────────────────────
  pi.registerCommand("cdev", {
    description: "Two-stage chain dev. Subcommands: auto on|off, review [path], quick <task>, status, prompts on|off, history, scan [deep], recall [topic], memory on|off, themed on|off",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      // Detect audit-only language ("check only", "don't change", etc.)
      const isAuditOnly = AUDIT_ONLY_RE.test(trimmed);
      const auditGuard = "\n\n⚠️ AUDIT ONLY — DO NOT implement, modify, or write any code. Only report findings and suggestions.";

      // ── Subcommand: auto on ──
      if (trimmed === "auto on" || trimmed === "auto") {
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).auto = true;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify("cdev auto mode ON — LLM will proactively use cdev for exploration", "info");
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: auto off ──
      if (trimmed === "auto off") {
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).auto = false;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify("cdev auto mode OFF", "info");
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: scan deep ──
      if (trimmed === "scan deep") {
        const config = loadConfig(ctx.cwd);
        const profiles = resolveStageProfiles(config);
        if (profiles.warning) {
          ctx.ui.notify(profiles.warning, "warn");
          return;
        }
        ctx.ui.notify("Deep scanning project (stage 1 → stage 2)...", "info");
        try {
          const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
          if (!snapshot) { ctx.ui.notify("Cannot snapshot session.", "error"); return; }

          const task = `Scan this project's architecture, conventions, and patterns. Generate 3 focused prompts for future cdev use:
1. explore — what to focus on during exploration (stack-specific patterns, conventions, key areas)
2. synthesize — how to structure synthesis reports (what risks to flag, what ordering matters)
3. review — what to check during code review (project-specific pitfalls, conventions, anti-patterns)

Read package.json, key source files, config files, and directory structure. Return ONLY the 3 prompts in this format:

EXPLORE_PROMPT:
<text>

SYNTHESIZE_PROMPT:
<text>

REVIEW_PROMPT:
<text>`;

          const scanTask = withAuditGuard(task);
          const scanStartTime = Date.now();
          const onProgress = (stage: string, model: string) => {
            if (stage === "scout") {
              ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔍 Scout exploring…  (${model})`)]);
            } else {
              ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge synthesizing…  (${model})`)]);
            }
          };
          onProgress("scout", profiles.stage1.id);
          const { result, details: scanDetails } = await runAutoFork({
            cwd: ctx.cwd,
            task: scanTask,
            forkSessionSnapshotJsonl: snapshot,
            stage1Profile: profiles.stage1,
            stage2Profile: profiles.stage2,
            onProgress,
            extensions: config.extensions,
            environment: config.environment,
            offline: config.offline,
            signal: undefined,
          });
          ctx.ui.setWidget("cdev-progress", undefined);

          saveSession(ctx.cwd, task, false, scanStartTime, scanDetails, result);
          if (result.errorMessage) {
            logError(ctx.cwd, "deep-scan-fork", new Error(result.errorMessage));
          }
          if (config.memory) {
            indexFindings({
              task,
              resultText: getFinalAssistantText(result.messages) || "",
              stage1Model: scanDetails.stage1?.model ?? profiles.stage1.id,
              stage2Model: scanDetails.stage2?.model ?? profiles.stage2.id,
              isReview: false,
              quick: false,
              cost: (result.usage?.cost ?? 0),
              cwd: ctx.cwd,
            });
          }

          // Parse prompts from result
          const text = getFinalAssistantText(result.messages) || "";
          const exploreMatch = text.match(/EXPLORE_PROMPT:\s*\n([\s\S]*?)(?=\n\nSYNTHESIZE_PROMPT:|$)/i);
          const synthMatch = text.match(/SYNTHESIZE_PROMPT:\s*\n([\s\S]*?)(?=\n\nREVIEW_PROMPT:|$)/i);
          const reviewMatch = text.match(/REVIEW_PROMPT:\s*\n([\s\S]*?)$/i);

          const explore = exploreMatch?.[1]?.trim() || "";
          const synthesize = synthMatch?.[1]?.trim() || "";
          const review = reviewMatch?.[1]?.trim() || "";

          if (!explore && !review) {
            ctx.ui.notify("Could not parse prompts from model output. Falling back to template scan.", "warn");
            return; // user can run /cdev scan for template
          }

          // Save to project .pi/settings.json
          const projectDir = join(ctx.cwd, ".pi");
          if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });
          const projectSettingsPath = join(projectDir, "settings.json");
          let projSettings: Record<string, unknown> = {};
          if (existsSync(projectSettingsPath)) {
            projSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
          }
          if (!projSettings["pi-chain-dev"]) projSettings["pi-chain-dev"] = {};
          (projSettings["pi-chain-dev"] as Record<string, unknown>).prompts = { explore, synthesize, review };
          (projSettings["pi-chain-dev"] as Record<string, unknown>).promptsEnabled = true;
          writeFileSync(projectSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");

          ctx.ui.notify(
            `Deep scan complete!\nScout: ${scanDetails.stage1?.model || "?"}\nForge: ${scanDetails.stage2?.model || "?"}\n\nPrompts saved to .pi/settings.json\nToggle: /cdev prompts on|off`,
            "info"
          );
          updatePromptsStatus(ctx);
        } catch (err) {
          logError(ctx.cwd, "deep-scan", err);
          ctx.ui.notify(`Deep scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // ── Subcommand: scan ──
      if (trimmed === "scan") {
        ctx.ui.notify("Scanning project for stack detection...", "info");
        try {
          const result = scanProject(ctx.cwd);
          const report = formatScanReport(result);

          // Save prompts to PROJECT's .pi/settings.json
          const projectDir = join(ctx.cwd, ".pi");
          if (!existsSync(projectDir)) {
            mkdirSync(projectDir, { recursive: true });
          }
          const projectSettingsPath = join(projectDir, "settings.json");
          let projSettings: Record<string, unknown> = {};
          if (existsSync(projectSettingsPath)) {
            projSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
          }
          if (!projSettings["pi-chain-dev"]) projSettings["pi-chain-dev"] = {};
          (projSettings["pi-chain-dev"] as Record<string, unknown>).prompts = result.prompts;
          (projSettings["pi-chain-dev"] as Record<string, unknown>).promptsEnabled = true;
          writeFileSync(projectSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");

          ctx.ui.notify(report, "info");
          updatePromptsStatus(ctx);
        } catch (err) {
          logError(ctx.cwd, "template-scan", err);
          ctx.ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // ── Subcommand: recall ──
      const recallMatch = trimmed.match(/^recall(?:\s+(.+))?$/);
      if (recallMatch) {
        const config = loadConfig(ctx.cwd);
        if (!config.memory) {
          ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
          return;
        }
        const topic = recallMatch[1]?.trim();
        if (topic) {
          const entry = memoryGetTopic(ctx.cwd, topic);
          if (entry) {
            ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
          } else {
            ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
          }
        } else {
          const memory = loadMemory(ctx.cwd);
          ctx.ui.notify(formatMemoryTopics(memory), "info");
        }
        return;
      }

      // ── Subcommand: view (alias for recall) ──
      const viewMatch = trimmed.match(/^view(?:\s+(.+))?$/);
      if (viewMatch) {
        const topic = viewMatch[1]?.trim();
        if (topic) {
          const entry = memoryGetTopic(ctx.cwd, topic);
          if (entry) {
            ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
          } else {
            ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
          }
        } else {
          const memory = loadMemory(ctx.cwd);
          ctx.ui.notify(formatMemoryTopics(memory), "info");
        }
        return;
      }

      // ── Subcommand: clear ──
      if (trimmed === "clear") {
        memoryClear(ctx.cwd);
        // Also clear old reports
        let cleared = 0;
        const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
        if (existsSync(reportsDir)) {
          for (const entry of readdirSync(reportsDir)) {
            if (entry.endsWith(".md")) {
              unlinkSync(join(reportsDir, entry));
              cleared++;
            }
          }
        }
        ctx.ui.notify(`Cleared cdev project memory${cleared > 0 ? ` + ${cleared} report${cleared !== 1 ? "s" : ""}` : ""}.`, "info");
        return;
      }

      // ── Subcommand: clear reports ──
      if (trimmed === "clear reports") {
        const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
        let cleared = 0;
        if (existsSync(reportsDir)) {
          for (const entry of readdirSync(reportsDir)) {
            if (entry.endsWith(".md")) {
              unlinkSync(join(reportsDir, entry));
              cleared++;
            }
          }
        }
        ctx.ui.notify(`Cleared ${cleared} cdev report${cleared !== 1 ? "s" : ""}.`, "info");
        return;
      }

      // ── Subcommand: memory clear ──
      if (trimmed === "memory clear") {
        memoryClear(ctx.cwd);
        ctx.ui.notify("Cleared all cdev project memory.", "info");
        return;
      }

      // ── Subcommand: clear error ──
      if (trimmed === "clear error") {
        const count = getErrorCount(ctx.cwd);
        clearErrorLog(ctx.cwd);
        ctx.ui.notify(`Cleared ${count} error${count !== 1 ? "s" : ""} from cdev error log.`, "info");
        return;
      }

      // ── Subcommand: memory forget <topic> ──
      const memoryForgetMatch = trimmed.match(/^memory forget\s+(.+)$/);
      if (memoryForgetMatch) {
        const topic = memoryForgetMatch[1].trim();
        const removed = memoryForget(ctx.cwd, topic);
        if (removed) {
          ctx.ui.notify(`Removed memory for topic "${topic}".`, "info");
        } else {
          ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
        }
        return;
      }

      // ── Subcommand: memory on/off ──
      if (trimmed === "memory on" || trimmed === "memory off") {
        const enable = trimmed === "memory on";
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).memory = enable;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify(`Project memory ${enable ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Subcommand: themed on/off ──
      if (trimmed === "themed on" || trimmed === "themed off") {
        const enable = trimmed === "themed on";
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).themed = enable;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

        // Also write to project settings if a project-level override exists (keeps them in sync)
        const projSettingsPath = join(ctx.cwd, ".pi", "settings.json");
        if (existsSync(projSettingsPath)) {
          const projSettings = JSON.parse(readFileSync(projSettingsPath, "utf-8"));
          const projCdev = projSettings?.["pi-chain-dev"] as Record<string, unknown> | undefined;
          if (projCdev && "themed" in projCdev) {
            projCdev.themed = enable;
            writeFileSync(projSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");
          }
        }

        ctx.ui.notify(`Themed TUI rendering ${enable ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Subcommand: prompts on/off ──
      if (trimmed === "prompts on" || trimmed === "prompts off") {
        const enable = trimmed === "prompts on";
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).promptsEnabled = enable;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify(`Custom prompts ${enable ? "ON" : "OFF"}`, "info");
        updatePromptsStatus(ctx);
        return;
      }

      // ── Subcommand: history ──
      const historyMatch = trimmed.match(/^history(?:\s+(\d+))?$/);
      if (historyMatch) {
        const sessionNum = historyMatch[1] ? parseInt(historyMatch[1], 10) : undefined;
        if (sessionNum !== undefined) {
          const session = getSession(ctx.cwd, sessionNum);
          if (session) {
            ctx.ui.notify(formatSessionRecord(session), "info");
          } else {
            ctx.ui.notify(`No session #${sessionNum}. Try /cdev history to list.`, "warn");
          }
        } else {
          const sessions = listSessions(ctx.cwd);
          ctx.ui.notify(formatHistory(sessions), "info");
        }
        return;
      }

      // ── Subcommand: review [path|diff] [--audit] ──
      const reviewFileMatch = trimmed.match(/^review\s+(.+)$/);
      if (trimmed === "review" || reviewFileMatch) {
        // Extract --audit flag and clean arg
        let isAudit = false;
        let cleanArg = "";
        if (reviewFileMatch) {
          cleanArg = reviewFileMatch[1].trim();
          if (cleanArg.endsWith(" --audit")) { cleanArg = cleanArg.slice(0, -8).trim(); isAudit = true; }
          else if (cleanArg.endsWith(" -a")) { cleanArg = cleanArg.slice(0, -3).trim(); isAudit = true; }
          else if (cleanArg === "--audit" || cleanArg === "-a") {
            // Just --audit without a path/diff — session audit review
            ctx.ui.notify(`Queuing audit-only code review…`, "info");
            pi.sendUserMessage(`Run a code review using the cdev tool with review=true and auditOnly=true.`, {
              triggerTurn: true,
              deliverAs: "steer",
            });
            return;
          }
          // Only set isAudit from --audit flag embedded in text (not suffix — suffix handled above)
          if (!isAudit && /\b--audit\b|\baudit.only\b|\bcheck.only\b/i.test(cleanArg)) {
            isAudit = true;
            cleanArg = cleanArg.replace(/\s*--audit\b|\s*\baudit.only\b|\s*\bcheck.only\b/gi, "").trim();
          }
        } else if (trimmed === "review --audit" || trimmed === "review -a") {
          isAudit = true;
        }
        const config = loadConfig(ctx.cwd);
        const reviewProfile = config.review ?? config.stage2;
        if (!reviewProfile.provider || !reviewProfile.id) {
          ctx.ui.notify("Review model not configured. Use /cdev-model to set models.", "warn");
          return;
        }
        if (cleanArg) {
          // Detect diff spec: contains '..' (git) or 'rN:M' (SVN)
          const isDiff = cleanArg.includes("..") || /^r\d+[:\-]\d+$/.test(cleanArg);
          // Detect file path: contains / \ or a file extension
          const looksLikePath = /[\\\/]/.test(cleanArg) || /\.[a-z]{2,6}$/i.test(cleanArg);
          if (isDiff) {
            // Diff review
            ctx.ui.notify(`Reviewing diff ${cleanArg}…`, "info");
            pi.sendUserMessage(`Review the diff ${cleanArg} using cdev with review=true, diffSpec="${cleanArg}"${isAudit ? ", and auditOnly=true" : ""}.`, {
              triggerTurn: true,
              deliverAs: "steer",
            });
          } else if (looksLikePath) {
            // File review — resolve path (handle absolute paths, relative paths, and .pi/... paths)
            const fullPath = isAbsolute(cleanArg) ? cleanArg : join(ctx.cwd, cleanArg);
            if (!existsSync(fullPath)) {
              ctx.ui.notify(`File not found: ${fullPath}`, "error");
              return;
            }
            ctx.ui.notify(`Reviewing ${cleanArg}…`, "info");
            pi.sendUserMessage(`Review the file ${cleanArg} using cdev with review=true, reviewFile="${cleanArg}"${isAudit ? ", and auditOnly=true" : ""}.`, {
              triggerTurn: true,
              deliverAs: "steer",
            });
          } else {
            // Plain text — treat as session review with a custom task hint
            ctx.ui.notify(`Queuing code review…`, "info");
            pi.sendUserMessage(`Run a code review using the cdev tool with review=true${isAudit ? " and auditOnly=true" : ""}. Focus on: ${cleanArg}`, {
              triggerTurn: true,
              deliverAs: "steer",
            });
          }
        } else {
          // Session review
          ctx.ui.notify(`Queuing code review (forge only)${isAudit ? " — audit only" : ""}…`, "info");
          pi.sendUserMessage(`Run a code review using the cdev tool with review=true${isAudit ? " and auditOnly=true" : ""}. Review the recent changes in this session for bugs, edge cases, and improvements.`, {
            triggerTurn: true,
            deliverAs: "steer",
          });
        }
        return;
      }

      // ── Subcommand: quick ──
      if (trimmed.startsWith("quick ")) {
        const quickTask = trimmed.slice(6).trim();
        if (!quickTask) {
          ctx.ui.notify("Usage: /cdev quick <task>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing quick exploration (stage 1 only)...`, "info");
        pi.sendUserMessage(`Use cdev with quick=true to: ${quickTask}${AUDIT_ONLY_RE.test(quickTask) ? auditGuard : ""}`, {
          triggerTurn: true,
          deliverAs: "steer",
        });
        return;
      }

      // ── Subcommand: status ──
      if (trimmed === "status" || trimmed === "info") {
        const config = loadConfig(ctx.cwd);
        const lines: string[] = [
          "── cdev status ─────────────────────────────────────",
          "",
          `  👤 ${resolveSignature(config)}`,
          "",
          `  Current model:    ${ctx.model ? ctx.model.id : "none"}`,
          `  Scout:  ${config.stage1.provider}:${config.stage1.id}  •  ${config.stage1.thinking}`,
          `  Forge:  ${config.stage2.provider}:${config.stage2.id}  •  ${config.stage2.thinking}`,
          `  Review: ${config.review ? `${config.review.provider}:${config.review.id}  •  ${config.review.thinking}` : `↳ Forge (${config.stage2.id})`}`,
          `  Auto-trigger:     ${config.auto ? "⚡ ON (sends steer every 3 turns to prompt cdev use)" : "OFF (agent uses cdev only when asked or it decides)"}`,
          `  Custom prompts:   ${config.prompts?.explore || config.prompts?.review ? (config.promptsEnabled ? "📋 ON (custom)" : "📋✕ OFF (custom exists)") : "— (none)"}`,
          `  Cost footer:      ${config.costFooter ? "ON" : "OFF"}`,
          `  Project memory:   ${config.memory ? "ON" : "OFF"}`,
          ...(config.themed ? [`  Themed TUI:       🎨 ON`] : []),
          `  Offline mode:     ${config.offline ? "ON" : "OFF"}`,
          `  Extensions:       ${config.extensions === null ? "inherit" : config.extensions.length === 0 ? "none" : config.extensions.join(", ")}`,
          "",
        ];
        const sessions = listSessions(ctx.cwd);
        if (sessions.length > 0) {
          let totalCost = 0;
          for (const s of sessions) totalCost += (s.stage1?.cost ?? 0) + (s.stage2?.cost ?? 0);
          lines.push(`  Sessions:         ${sessions.length} (7-day window, $${totalCost.toFixed(4)} total)`);
        }
        const topicCount = memoryTopicCount(ctx.cwd);
        if (topicCount > 0 && config.memory) {
          lines.push(`  Project memory:   ${topicCount} topic${topicCount > 1 ? "s" : ""}  /cdev recall`);
        }
        const errorCount = getErrorCount(ctx.cwd);
        if (errorCount > 0) {
          lines.push(`  Error log:        ${errorCount} error${errorCount > 1 ? "s" : ""}  /cdev clear error to wipe`);
        }
        lines.push("");
        lines.push("─────────────────────────────────────────────────────");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── Help ──
      if (trimmed === "help" || trimmed === "?" || trimmed === "h") {
        await ctx.ui.select("cdev subcommands:", [
          "/cdev <task>           Scout + Forge explore",
          "/cdev quick <task>     Scout only (fast)",
          "/cdev review [path]    Forge review session/file",
          "/cdev review A..B      Review git/svn diff",
          "/cdev scan [deep]      Generate custom prompts",
          "/cdev history [n]      Past session details",
          "/cdev recall [topic]   Check project memory",
          "/cdev status           Config overview",
          "/cdev memory on|off    Toggle project memory",
          "/cdev prompts on|off   Toggle custom prompts",
          "/cdev themed on|off    Toggle themed TUI",
          "/cdev auto on|off      Toggle auto-trigger",
        ]);
        return;
      }

      // ── Default: task mode ──
      if (!trimmed) {
        await ctx.ui.select("cdev — Model-chained development fork", [
          "Usage: /cdev <task>",
          "",
          "Scout (cheap) explores → Forge (powerful) writes",
          "",
          "Subcommands:",
          "  quick <task>     Scout only (fast findings)",
          "  review [path]    Forge review session, file, or diff",
          "  scan [deep]      Generate custom prompts",
          "  history [n]      Past fork sessions",
          "  recall [topic]   Check project memory",
          "  status           Full config overview",
          "  memory on|off    Toggle memory",
          "  prompts on|off   Toggle custom prompts",
          "  themed on|off    Toggle themed TUI",
          "  auto on|off      Toggle auto-trigger",
          "",
          "More: /cdev-help  /cdev-model",
        ]);
        return;
      }

      // ── Fuzzy match: suggest if close to a subcommand (single-word only) ──
      const subcommands = ["status", "quick", "review", "scan", "history", "recall", "view", "info", "memory", "prompts", "auto", "help", "clear"];
      const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
      const isSingleWord = !trimmed.includes(" ");
      const fuzzy = subcommands.find(cmd => {
        if (cmd === firstWord) return false;
        // Prefix match (e.g. "hist" → "history", "sta" → "status")
        if (cmd.startsWith(firstWord) || firstWord.startsWith(cmd)) return true;
        // 1-char typo check
        if (firstWord.length >= 3 && cmd.length >= 3) {
          let diffs = 0;
          const shorter = firstWord.length < cmd.length ? firstWord : cmd;
          for (let i = 0; i < shorter.length; i++) {
            if (firstWord[i] !== cmd[i]) diffs++;
          }
          if (diffs <= 1) return true;
        }
        return false;
      });
      if (fuzzy && isSingleWord) {
        const choice = await ctx.ui.select(
          `Unknown: /cdev ${firstWord}`,
          [
            `→ /cdev ${fuzzy}        (suggested)`,
            `Run as task: /cdev ${firstWord}`,
          ]
        );
        if (!choice) return;
        if (choice.startsWith("→")) {
          return; // acknowledged; user will type the correct command next time
        }
        // User chose "Run as task" — fall through to task queue
      }

      // Not a subcommand → treat as task
      ctx.ui.notify("Queuing cdev task...", "info");
      pi.sendUserMessage(`Use cdev to: ${trimmed}${isAuditOnly ? auditGuard : ""}`, {
        triggerTurn: true,
        deliverAs: "steer",
      });
    },
  });

  // ── Register /cdev-model command ─────────────────────────
  pi.registerCommand("cdev-model", {
    description: "Pick scout/forge models for cdev tool",
    handler: async (_args, ctx) => {
      try {
      const config = loadConfig(ctx.cwd);

      // Step 1: pick stage
      const reviewProfile = config.review ?? config.stage2;
      const stagePick = await ctx.ui.select("Pick model:", [
        `Scout (explore)  [${config.stage1.provider || "?"}/${config.stage1.id || "?"}]`,
        `Forge (synthesize)  [${config.stage2.provider || "?"}/${config.stage2.id || "?"}]`,
        `Review  [${reviewProfile.provider || "?"}/${reviewProfile.id || "?"}]`,
      ]);
      if (!stagePick) return;
      const stage = stagePick.startsWith("Scout") ? "stage1"
        : stagePick.startsWith("Forge") ? "stage2"
        : "review";

      // Step 2: show all models via select (max 50)
      const allModels = ctx.modelRegistry.getAvailable();
      const modelItems = allModels.slice(0, 50).map(m =>
        `${m.id} [${m.provider}]`
      );
      const modelPick = await ctx.ui.select(
        `Pick ${stage} model (arrow keys to scroll):`,
        modelItems
      );
      if (!modelPick) return;
      
      // Parse "modelId [provider]"
      const match = modelPick.match(/^(.+?)\s+\[(.+?)\]/);
      if (!match) { ctx.ui.notify("Parse error: " + modelPick, "error"); return; }
      const modelId = match[1].trim();
      const provider = match[2].trim();

      // Step 3: pick thinking
      const thinkingPick = await ctx.ui.select("Pick thinking level:", [
        "off", "minimal", "low", "medium", "high", "xhigh",
      ]);
      if (!thinkingPick) return;

      // Save
      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
      if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
      (settings["pi-chain-dev"] as Record<string, unknown>)[stage] = {
        provider, id: modelId, thinking: thinkingPick,
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`Set ${stage} to ${provider}/${modelId} (${thinkingPick}). /reload to apply.`, "info");
      } catch (err) {
        logError(ctx.cwd, "cdev-model", err);
        ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── Register /cdev-help command ──────────────────────────
  pi.registerCommand("cdev-help", {
    description: "Show cdev subcommands",
    handler: async (_args, ctx) => {
      await ctx.ui.select("cdev subcommands:", [
        "──────────────────────────────────────",
        "/cdev <task>           Scout + Forge explore",
        "/cdev quick <task>     Scout only (fast)",
        "/cdev review [path]    Forge review session/file",
        "/cdev review A..B      Review git/svn diff",
        "/cdev scan [deep]      Generate custom prompts",
        "/cdev history [n]      Past session details",
        "/cdev recall [topic]   Check project memory",
        "/cdev status           Config overview",
        "/cdev memory on|off    Toggle project memory",
        "/cdev prompts on|off   Toggle custom prompts",
        "/cdev themed on|off    Toggle themed TUI",
        "/cdev auto on|off      Toggle auto-trigger",
        "──────────────────────────────────────",
        "/cdev-model            Pick scout/forge models",
        "/cdev-help             This help",
      ]);
    },
  });
}
