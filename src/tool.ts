import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runAutoFork, runCdevReview, runFileReview, runDiffReview, runYoloLoop, runCdevResearch } from "./runner.js";
import { setStageSemaphoreMaxConcurrency } from "./fork-stage.js";
import { computeReportDiff, formatReportDiff, parsePlanReport, parseStage2Report } from "./json-extract.js";
import { writeReportFile } from "./report.js";
import { isPathUnderCwd } from "./path-guards.js";
import { getFinalAssistantText } from "./runner-events.js";
import { emptyFailedResult, normalizeYoloConfig, type AutoForkDetails, type AutoForkUiDetails } from "./types.js";
import { saveSession, findPreviousSession } from "./history.js";
import { indexFindingsAsync, memoryGetTopic, formatTopicDetail, loadMemory, formatMemoryTopics } from "./memory.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  estimateTokens,
  setTokenEstimationRatio,
  resolveStageProfiles,
  logError,
  checkCostBudget,
  recordForkCost,
  estimateForkCost,
  formatCost,
  maybeWarnSessionSize,
  maybeNotifyCostAlert,
  formatForkResultOutput,
} from "./extension-context.js";

export interface AutoForkParamsType {
  task?: string;
  review?: boolean;
  quick?: boolean;
  verify?: boolean;
  plan?: boolean;
  yolo?: boolean;
  research?: boolean;
  parallel?: number;
  parallelBackup?: boolean;
  recall?: string;
  reviewFile?: string;
  diffSpec?: string;
}

interface SnapshotOk {
  snapshot: string;
  snapshotTokens: number;
}
interface CompactTrigger {
  autoCompact: { tokens: number; limit: number };
}

type SnapshotResult = SnapshotOk | CompactTrigger | null;

function checkSessionSnapshot(
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof loadConfig>>,
): SnapshotResult {
  const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager, config.modelContextLimit);
  if (!snapshot) return null;
  const snapshotTokens = estimateTokens(snapshot);
  const limit = config.modelContextLimit ?? 262_144;
  if (snapshotTokens > limit * 0.95) {
    if (config.autoCompactOnLimit) {
      ctx.ui.notify(`Session snapshot is ~${snapshotTokens.toLocaleString()} tokens — auto-compacting parent session. Retry after /compact completes.`, "warn");
      return { autoCompact: { tokens: snapshotTokens, limit } };
    }
    ctx.ui.notify(`Session snapshot is ~${snapshotTokens.toLocaleString()} tokens. Consider running /compact to avoid model limit errors.`, "warn");
  }
  return { snapshot, snapshotTokens };
}

function isCompactTrigger(result: SnapshotResult): result is CompactTrigger {
  return result !== null && "autoCompact" in result;
}

function formatCompactMessage(result: CompactTrigger): string {
  const { tokens, limit } = result.autoCompact;
  return `cdev: Session snapshot is ~${tokens.toLocaleString()} tokens, nearing the model context limit (${limit.toLocaleString()}). Auto-compacting parent session; retry this task after /compact completes.`;
}

export type { SnapshotOk, CompactTrigger };

function buildReportUiDetails(text: string | undefined, base: AutoForkUiDetails): AutoForkUiDetails {
  if (!text) return base;
  const report = parseStage2Report(text);
  if (report) {
    return {
      ...base,
      status: report.status,
      groundingScore: report.groundingScore,
      qualityScore: report.qualityScore,
      ungroundedClaimCount: report.ungroundedClaims?.length ?? 0,
      actionItemCount: report.actionItems.length,
      coverage: report.coverage,
    };
  }
  const plan = parsePlanReport(text);
  if (plan) {
    return {
      ...base,
      mode: base.mode ?? "plan",
      status: plan.status,
      groundingScore: plan.groundingScore,
      qualityScore: plan.qualityScore,
      ungroundedClaimCount: plan.ungroundedClaims?.length ?? 0,
      actionItemCount: plan.steps.length,
      coverage: plan.coverage,
    };
  }
  return base;
}

function withUiDetails(details: AutoForkDetails, ui: AutoForkUiDetails): AutoForkDetails {
  return { ...details, ui };
}

function validateAutoForkParams(params: Record<string, unknown>): { valid: true; value: AutoForkParamsType } | { valid: false; error: string } {
  const out: AutoForkParamsType = {};
  const errors: string[] = [];

  if (params.task !== undefined) {
    if (typeof params.task !== "string") errors.push("task must be a string");
    else out.task = params.task;
  }
  for (const key of ["review", "quick", "verify", "plan", "yolo", "research"] as const) {
    if (params[key] !== undefined) {
      if (typeof params[key] !== "boolean") errors.push(`${key} must be a boolean`);
      else out[key] = params[key];
    }
  }
  for (const key of ["recall", "reviewFile", "diffSpec"] as const) {
    if (params[key] !== undefined) {
      if (typeof params[key] !== "string") errors.push(`${key} must be a string`);
      else out[key] = params[key];
    }
  }

  if (errors.length > 0) return { valid: false, error: errors.join("; ") };
  return { valid: true, value: out };
}

export async function executeCdevTool(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const validation = validateAutoForkParams(params);
  if (!validation.valid) {
    return {
      content: [{ type: "text" as const, text: `cdev error: ${validation.error}` }],
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }
  const p = validation.value;
  try {
    const config = loadConfig(ctx.cwd);
    setStageSemaphoreMaxConcurrency(config.maxConcurrentStages ?? 3);
    setTokenEstimationRatio(config.tokenEstimationCharsPerToken ?? 4);
    const themedBg = makeThemedBg(ctx, config.themed);

    // ── Recall mode ──
    if (p.recall !== undefined) {
      if (!config.memory) {
        return {
          content: [{ type: "text" as const, text: "cdev memory is disabled. Enable with /cdev memory on." }],
          details: { stage1: null, stage2: null },
        };
      }
      if (p.recall) {
        const entry = memoryGetTopic(ctx.cwd, p.recall);
        if (entry) {
          const detail = formatTopicDetail(entry, ctx.cwd);
          return {
            content: [{ type: "text" as const, text: `🧠 cdev memory hit: ${p.recall}\n\n${detail}` }],
            details: { stage1: null, stage2: null, ui: { mode: "recall", task: p.recall } },
          };
        }
        return {
          content: [{ type: "text" as const, text: `🧠 cdev memory miss: no findings for "${p.recall}".` }],
          details: { stage1: null, stage2: null, ui: { mode: "recall", task: p.recall } },
        };
      }
      const memory = loadMemory(ctx.cwd);
      const listing = formatMemoryTopics(memory);
      return {
        content: [{ type: "text" as const, text: `🧠 cdev memory\n\n${listing}` }],
        details: { stage1: null, stage2: null, ui: { mode: "recall" } },
      };
    }

    // ── Review mode ──
    if (p.review) {
      const reviewTask = p.task || "review";
      const reviewProfile = config.review ?? config.stage2;
      if (!reviewProfile.provider || !reviewProfile.id) {
        return {
          content: [{ type: "text" as const, text: "cdev review error: Review model not configured. Use /cdev-model." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      // File review
      if (typeof p.reviewFile === "string" && p.reviewFile.trim()) {
        const arg = p.reviewFile.trim();
        const filePath = isAbsolute(arg) ? arg : join(ctx.cwd, arg);
        if (!isPathUnderCwd(ctx.cwd, filePath)) {
          return {
            content: [{ type: "text" as const, text: `cdev review error: reviewFile must be inside the project workspace: ${p.reviewFile}` }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024;
        let fileContent: string;
        try {
          const stats = statSync(filePath);
          if (!stats.isFile()) {
            return {
              content: [{ type: "text" as const, text: `cdev review error: Not a regular file: ${filePath}` }],
              details: { stage1: null, stage2: null },
              isError: true,
            };
          }
          if (stats.size > MAX_REVIEW_FILE_BYTES) {
            return {
              content: [{ type: "text" as const, text: `cdev review error: File too large (${(stats.size / 1024 / 1024).toFixed(1)} MB > ${MAX_REVIEW_FILE_BYTES / 1024 / 1024} MB): ${filePath}` }],
              details: { stage1: null, stage2: null },
              isError: true,
            };
          }
          fileContent = readFileSync(filePath, "utf-8");
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `cdev review error: Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}` }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        const onProgress = (stage: string, model: string) => {
          const icon = stage === "scout" ? "🔍" : "⚒️";
          const label = stage === "scout" ? "Scout" : "Forge";
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} reviewing ${p.reviewFile}…  (${model})`)]);
        };
        onProgress("forge", reviewProfile.id);
        const startTime = Date.now();
        const { result, details } = await runFileReview({
          cwd: ctx.cwd,
          filePath: p.reviewFile,
          fileContent,
          stageProfile: reviewProfile,
          stageTimeoutMs: config.forgeTimeoutMs,
          onProgress,
          onUpdate: (update) => {
            ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge reviewing ${p.reviewFile}…  ${update.activity ?? ""}`)]);
          },
          extensions: config.extensions,
          environment: config.environment,
          offline: config.offline,
          signal,
        });
        ctx.ui.setWidget("cdev-progress", undefined);

        const reviewText = getFinalAssistantText(result.messages);
        const reviewSlug = `review-${p.reviewFile.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}.md`;
        const { reportRelPath } = writeReportFile({
          cwd: ctx.cwd,
          fileName: reviewSlug,
          title: `Review: ${p.reviewFile}`,
          reviewer: details.stage2?.model ?? "?",
          body: reviewText || "(no review output)",
        });

        saveSession(ctx.cwd, `review ${p.reviewFile}`, true, startTime, details, result);
        if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        const reviewCost = result.usage?.cost ?? 0;
        recordForkCost(ctx.cwd, reviewCost);
        maybeNotifyCostAlert(ctx, config);
        maybeWarnSessionSize(ctx);
        if (config.memory) {
          indexFindingsAsync({
            task: `review ${p.reviewFile}`,
            resultText: reviewText || "",
            stage2Model: reviewProfile.id,
            isReview: true,
            quick: false,
            cost: result.usage?.cost ?? 0,
            cwd: ctx.cwd,
          });
        }
        const isError = result.exitCode > 0 && !reviewText;
        const reviewOutput = formatForkResultOutput(result, details);
        const hasIssues = reviewText && (
          reviewText.includes("❌ missing") ||
          reviewText.includes("⚠️ partial") ||
          reviewText.includes("## Bugs Found") ||
          reviewText.includes("## Gaps") ||
          reviewText.includes("needs-work") ||
          reviewText.includes("## Issues Found") ||
          reviewText.includes("# Issues")
        );
        const actionNote = isError
          ? `\n\n---\n⚠️  Review failed. Report saved at ${reportRelPath}`
          : hasIssues
            ? `\n\n---\n⚠️  Review found issues. Read the report at ${reportRelPath}\nand address the new Action Items. Check them off in the report file when done.`
            : `\n\n---\n✅ Review passed. Report saved at ${reportRelPath}`;

        return {
          content: [{ type: "text" as const, text: reviewOutput + actionNote }],
          details: withUiDetails(details, buildReportUiDetails(reviewText, {
            mode: "review",
            task: `review ${p.reviewFile}`,
            reportPath: reportRelPath,
          })),
          isError,
        };
      }

      // Diff review
      if (typeof p.diffSpec === "string" && p.diffSpec.trim()) {
        const diffSpec = p.diffSpec.trim();
        if (diffSpec.startsWith("-") || /(^|\s)--?\w/.test(diffSpec)) {
          return {
            content: [{ type: "text" as const, text: `cdev review error: diffSpec must not start with '-' or contain flag-like tokens: ${diffSpec}` }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        if (/\.\.|^\/|\\/.test(diffSpec)) {
          return {
            content: [{ type: "text" as const, text: `cdev review error: diffSpec must not contain path traversal or absolute paths: ${diffSpec}` }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        let diffContent: string;
        try {
          const gitResult = spawnSync("git", ["diff", diffSpec], { cwd: ctx.cwd, maxBuffer: 2 * 1024 * 1024, encoding: "utf-8" });
          if (gitResult.error || gitResult.status !== 0) {
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
          stageTimeoutMs: config.forgeTimeoutMs,
          onProgress,
          onUpdate: (update) => {
            ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge reviewing diff ${diffSpec}…  ${update.activity ?? ""}`)]);
          },
          extensions: config.extensions,
          environment: config.environment,
          offline: config.offline,
          signal,
        });
        ctx.ui.setWidget("cdev-progress", undefined);

        const diffSlug = diffSpec.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 50);
        const ts = Date.now().toString(36);
        const reportFileName = `diff-${diffSlug}-${ts}.md`;
        const reviewText = getFinalAssistantText(result.messages);
        const { reportRelPath } = writeReportFile({
          cwd: ctx.cwd,
          fileName: reportFileName,
          title: `Diff Review: ${diffSpec}`,
          reviewer: details.stage2?.model ?? "?",
          body: reviewText || "(no review output)",
        });

        saveSession(ctx.cwd, `review diff ${diffSpec}`, true, startTime, details, result);
        if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        const diffReviewCost = result.usage?.cost ?? 0;
        recordForkCost(ctx.cwd, diffReviewCost);
        maybeNotifyCostAlert(ctx, config);
        maybeWarnSessionSize(ctx);
        if (config.memory) {
          indexFindingsAsync({
            task: `review diff ${diffSpec}`,
            resultText: reviewText || "",
            stage2Model: reviewProfile.id,
            isReview: true,
            quick: false,
            cost: result.usage?.cost ?? 0,
            cwd: ctx.cwd,
          });
        }
        const isError = result.exitCode > 0 && !reviewText;
        const reviewOutput = formatForkResultOutput(result, details);
        const actionNote = isError
          ? `\n\n---\n⚠️ Diff review failed. Report saved at ${reportRelPath}`
          : `\n\n---\n✅ Diff review complete. Report saved at ${reportRelPath}`;

        return {
          content: [{ type: "text" as const, text: reviewOutput + actionNote }],
          details: withUiDetails(details, buildReportUiDetails(reviewText, {
            mode: "review",
            task: `review diff ${diffSpec}`,
            reportPath: reportRelPath,
          })),
          isError,
        };
      }

      // Session review
      const snapshotResult = checkSessionSnapshot(ctx, config);
      if (snapshotResult === null) {
        return {
          content: [{ type: "text" as const, text: "cdev review error: Cannot snapshot session." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }
      if (isCompactTrigger(snapshotResult)) {
        return {
          content: [{ type: "text" as const, text: formatCompactMessage(snapshotResult) }],
          details: { stage1: null, stage2: null, autoCompact: snapshotResult.autoCompact },
        };
      }
      const { snapshot } = snapshotResult;
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
        stageTimeoutMs: config.forgeTimeoutMs,
        customReviewPrompt: config.promptsEnabled ? config.prompts?.review : undefined,
        onProgress,
        onUpdate: (update) => {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge reviewing…  ${update.activity ?? ""}`)]);
        },
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal,
      });
      ctx.ui.setWidget("cdev-progress", undefined);

      const reviewText = getFinalAssistantText(result.messages);
      const reviewSlug = `session-review-${Date.now().toString(36)}.md`;
      const { reportRelPath: reviewReportPath } = reviewText && !result.errorMessage
        ? writeReportFile({
            cwd: ctx.cwd,
            fileName: reviewSlug,
            title: "Session Review",
            reviewer: details.stage2?.model ?? "?",
            body: reviewText,
          })
        : { reportRelPath: "" };

      saveSession(ctx.cwd, reviewTask, true, startTime, details, result);
      if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
      const sessionReviewCost = result.usage?.cost ?? 0;
      recordForkCost(ctx.cwd, sessionReviewCost);
      maybeNotifyCostAlert(ctx, config);
      maybeWarnSessionSize(ctx);
      if (config.memory) {
        indexFindingsAsync({
          task: reviewTask,
          resultText: getFinalAssistantText(result.messages) || "",
          stage2Model: reviewProfile.id,
          isReview: true,
          quick: false,
          cost: result.usage?.cost ?? 0,
          cwd: ctx.cwd,
        });
      }
      const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);
      const suffix = reviewReportPath ? `\n\n---\n📄 Review report saved: ${reviewReportPath}` : "";
      return {
        content: [{ type: "text" as const, text: formatForkResultOutput(result, details) + suffix }],
        details: withUiDetails(details, buildReportUiDetails(reviewText, {
          mode: "review",
          task: reviewTask,
          reportPath: reviewReportPath || undefined,
        })),
        isError,
      };
    }

    // ── Full two-stage mode ──
    if (!p.task) {
      return {
        content: [{ type: "text" as const, text: "cdev error: task is required for fork mode." }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }
    const profiles = resolveStageProfiles(config);

    if (profiles.warning) {
      return {
        content: [{ type: "text" as const, text: `cdev error: ${profiles.warning}` }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }

    const snapshotResult = checkSessionSnapshot(ctx, config);
    if (snapshotResult === null) {
      const result = emptyFailedResult(
        p.task,
        "Cannot cdev: failed to snapshot current session context.",
      );
      return {
        content: [{ type: "text" as const, text: `cdev error: ${result.errorMessage}` }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }
    if (isCompactTrigger(snapshotResult)) {
      return {
        content: [{ type: "text" as const, text: formatCompactMessage(snapshotResult) }],
        details: { stage1: null, stage2: null, autoCompact: snapshotResult.autoCompact },
      };
    }
    const { snapshot } = snapshotResult;

    const quick = p.quick ?? false;
    const verify = p.verify ?? (config.autoVerify && !p.quick);

    // ── Research mode ──
    if (p.research) {
      if (!p.task) {
        return {
          content: [{ type: "text" as const, text: "cdev error: task is required for research mode." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }
      const researchProfile = config.research ?? profiles.stage1;
      if (!researchProfile.provider || !researchProfile.id) {
        return {
          content: [{ type: "text" as const, text: "cdev research error: Research model not configured. Use /cdev-model." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const estimate = estimateForkCost({
        task: withAuditGuard(p.task),
        stage1Profile: researchProfile,
        stage2Profile: researchProfile,
        quick: true,
        forkSessionSnapshotJsonl: snapshot ?? undefined,
      });
      const budgetCheck = checkCostBudget(config, ctx.cwd, estimate.cost);
      if (!budgetCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: `cdev budget error: ${budgetCheck.reason}\nEstimated: ~${formatCost(estimate.cost)} (${estimate.inputTokens} input / ${estimate.outputTokens} output tokens)` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const onProgress = (stage: string, model: string) => {
        if (stage === "research") {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔬 Researching…  (${model})`)]);
        }
      };
      onProgress("research", researchProfile.thinking ? `${researchProfile.provider}:${researchProfile.id} • ${researchProfile.thinking}` : `${researchProfile.provider}:${researchProfile.id}`);
      const startTime = Date.now();
      const { result, details } = await runCdevResearch({
        cwd: ctx.cwd,
        task: withAuditGuard(p.task),
        forkSessionSnapshotJsonl: snapshot,
        stageProfile: researchProfile,
        stageTimeoutMs: config.scoutTimeoutMs,
        customPrompt: config.promptsEnabled ? config.prompts?.research : undefined,
        onProgress,
        onUpdate: (update) => {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔬 Researching…  ${update.activity ?? ""}`)]);
        },
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal,
      });
      ctx.ui.setWidget("cdev-progress", undefined);

      const current = saveSession(ctx.cwd, p.task, false, startTime, details, result);

      if (result.errorMessage) logError(ctx.cwd, "research", new Error(result.errorMessage));
      const researchCost = result.usage?.cost ?? 0;
      recordForkCost(ctx.cwd, researchCost);
      maybeNotifyCostAlert(ctx, config);
      maybeWarnSessionSize(ctx);
      if (config.memory) {
        indexFindingsAsync({
          task: p.task,
          resultText: getFinalAssistantText(result.messages) || "",
          stage1Model: researchProfile.id,
          isReview: false,
          quick: false,
          cost: researchCost,
          cwd: ctx.cwd,
        });
      }

      const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);
      let resultText = formatForkResultOutput(result, details);

      const previous = findPreviousSession(ctx.cwd, p.task);
      if (previous?.resultText && previous.id !== current.id) {
        const diff = computeReportDiff(previous.resultText, getFinalAssistantText(result.messages) || "");
        if (diff.added.length > 0 || diff.removed.length > 0) {
          resultText += "\n\n---\n📊 Changes vs previous research\n\n" + formatReportDiff(diff);
        }
      }

      return {
        content: [{ type: "text" as const, text: resultText }],
        details: withUiDetails(details, buildReportUiDetails(getFinalAssistantText(result.messages), {
          mode: "research",
          task: p.task,
        })),
        isError,
      };
    }

    // ── YOLO review-fix loop mode ──
    if (p.yolo) {
      if (!p.task) {
        return {
          content: [{ type: "text" as const, text: "cdev error: task is required for yolo mode." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const yolo = normalizeYoloConfig(config.yolo);
      const yoloEstimate = estimateForkCost({
        task: p.task,
        stage1Profile: profiles.stage1,
        stage2Profile: profiles.stage2,
        forkSessionSnapshotJsonl: snapshot ?? undefined,
      });
      const yoloBudgetCheck = checkCostBudget(config, ctx.cwd, yoloEstimate.cost);
      if (!yoloBudgetCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: `cdev budget error: ${yoloBudgetCheck.reason}\nEstimated initial fork: ~${formatCost(yoloEstimate.cost)}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const reviewProfile = yolo.reviewProfile ?? config.review ?? profiles.stage2;
      const fixProfile = yolo.fixProfile ?? profiles.stage2;
      if (!reviewProfile.provider || !reviewProfile.id) {
        return {
          content: [{ type: "text" as const, text: "cdev yolo error: Review model not configured. Use /cdev-model." }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const onYoloProgress = (stage: "scout" | "forge" | "review" | "fix", model: string, round?: number) => {
        const roundLabel = round !== undefined ? ` (round ${round})` : "";
        if (stage === "scout") {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔍 Scout exploring${roundLabel}…  (${model})`)]);
        } else if (stage === "forge") {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge synthesizing${roundLabel}…  (${model})`)]);
        } else if (stage === "review") {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔎 Reviewing${roundLabel}…  (${model})`)]);
        } else {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔧 Fixing${roundLabel}…  (${model})`)]);
        }
      };

      const yoloResult = await runYoloLoop({
        cwd: ctx.cwd,
        task: p.task,
        forkSessionSnapshotJsonl: snapshot,
        stage1Profile: profiles.stage1,
        stage1bProfile: config.stage1b,
        stage2Profile: profiles.stage2,
        config,
        yoloConfig: yolo,
        reviewProfile,
        fixProfile,
        customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
        customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
        customReviewPrompt: config.promptsEnabled ? config.prompts?.review : undefined,
        scoutTimeoutMs: config.scoutTimeoutMs,
        forgeTimeoutMs: config.forgeTimeoutMs,
        onProgress: onYoloProgress,
        onUpdate: (update) => {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", update.activity ?? "working…")]);
        },
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal,
      });
      ctx.ui.setWidget("cdev-progress", undefined);

      recordForkCost(ctx.cwd, yoloResult.totalCost);
      maybeNotifyCostAlert(ctx, config);
      maybeWarnSessionSize(ctx);
      if (config.memory) {
        indexFindingsAsync({
          task: p.task,
          resultText: getFinalAssistantText(yoloResult.initial.result.messages) || "",
          stage1Model: config.stage1.id,
          stage2Model: config.stage2.id,
          isReview: false,
          quick: false,
          cost: yoloResult.totalCost,
          cwd: ctx.cwd,
        });
      }

      const verdictLabel = yoloResult.finalVerdict === "pass" ? "✅ pass" : yoloResult.finalVerdict === "blocked" ? "❌ blocked" : "⚠️ needs-work";
      const summary = `YOLO loop complete.\n\nRounds used: ${yoloResult.rounds.length} / ${yolo.maxRounds}\nTotal cost: ${formatCost(yoloResult.totalCost)}\nFinal verdict: ${verdictLabel}\nFinal report: ${yoloResult.finalReportPath}\n\nInitial report: ${yoloResult.initial.reportPath}`;

      return {
        content: [{ type: "text" as const, text: summary }],
        details: withUiDetails(
          yoloResult.rounds.length > 0 ? yoloResult.rounds[yoloResult.rounds.length - 1].review.details : yoloResult.initial.details,
          {
            mode: "yolo",
            task: p.task,
            reportPath: yoloResult.finalReportPath,
            status: yoloResult.finalVerdict === "pass" ? "ok" : yoloResult.finalVerdict === "blocked" ? "blocked" : "needs-work",
          },
        ),
        isError: yoloResult.finalVerdict !== "pass",
      };
    }

    const estimate = estimateForkCost({
      task: withAuditGuard(p.task),
      stage1Profile: profiles.stage1,
      stage2Profile: profiles.stage2,
      quick,
      verify,
      forkSessionSnapshotJsonl: snapshot ?? undefined,
    });
    const budgetCheck = checkCostBudget(config, ctx.cwd, estimate.cost);
    if (!budgetCheck.allowed) {
      return {
        content: [{ type: "text" as const, text: `cdev budget error: ${budgetCheck.reason}\nEstimated: ~${formatCost(estimate.cost)} (${estimate.inputTokens} input / ${estimate.outputTokens} output tokens)` }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }

    const isPlan = p.plan === true;
    const parallel = Math.max(1, Math.min(3, Number.isFinite(p.parallel) ? (p.parallel as number) : (config.parallel ?? 1)));
    const parallelBackup = typeof p.parallelBackup === "boolean" ? p.parallelBackup : (config.parallelBackup ?? false);
    const useParallel = parallel > 1 && !quick && !verify;

    const onProgress = (stage: string, model: string) => {
      if (stage === "scout") {
        const icon = useParallel ? "🔀" : verify ? "🔍🔍" : "🔍";
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} Scout exploring…  (${model})`)]);
      } else {
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${isPlan ? "📋" : "⚒️"} Forge ${isPlan ? "planning" : "synthesizing"}…  (${model})`)]);
      }
    };
    const modelStr = (prof: typeof profiles.stage1) => prof.thinking ? `${prof.provider}:${prof.id} • ${prof.thinking}` : `${prof.provider}:${prof.id}`;
    onProgress("scout", modelStr(profiles.stage1));
    const startTime = Date.now();
    const { result, details } = await runAutoFork({
      cwd: ctx.cwd,
      task: withAuditGuard(p.task),
      forkSessionSnapshotJsonl: snapshot,
      stage1Profile: profiles.stage1,
      stage1bProfile: config.stage1b,
      stage1cProfile: config.stage1c,
      stage1BackupProfile: config.stage1Backup,
      stage2Profile: profiles.stage2,
      customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
      customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
      customPlanPrompt: config.promptsEnabled ? config.prompts?.plan : undefined,
      quick,
      verify,
      plan: isPlan,
      parallel,
      parallelBackup,
      scoutTimeoutMs: config.scoutTimeoutMs,
      forgeTimeoutMs: config.forgeTimeoutMs,
      confidenceGates: config.confidenceGates,
      onProgress,
      onUpdate: (update) => {
        const icon = update.stage.includes("exploration") || update.stage === "scout" ? "🔍" : isPlan ? "📋" : "⚒️";
        const label = update.stage.includes("exploration") || update.stage === "scout" ? "Scout" : isPlan ? "Planner" : "Forge";
        const activity = update.activity ? `  ${update.activity}` : "";
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} ${update.stage}…${activity}`)]);
      },
      extensions: config.extensions,
      environment: config.environment,
      offline: config.offline,
      signal,
    });
    ctx.ui.setWidget("cdev-progress", undefined);

    const current = saveSession(ctx.cwd, p.task, false, startTime, details, result);

    let reportRelPath = "";
    if (!quick && details.stage2 && !result.errorMessage) {
      const reportText = getFinalAssistantText(result.messages);
      if (reportText) {
        const slugBase = p.task
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .toLowerCase()
          .slice(0, 60);
        const slug = `${slugBase}-${Date.now().toString(36)}`;
        const { reportRelPath: savedPath } = writeReportFile({
          cwd: ctx.cwd,
          fileName: `${slug}.md`,
          title: isPlan ? "cdev plan" : "cdev report",
          body: reportText,
        });
        reportRelPath = savedPath;
      }
    }
    if (result.errorMessage) logError(ctx.cwd, "full-mode", new Error(result.errorMessage));
    const forkCost = result.usage?.cost ?? 0;
    recordForkCost(ctx.cwd, forkCost);
    maybeNotifyCostAlert(ctx, config);
    if (config.memory) {
      indexFindingsAsync({
        task: p.task,
      resultText: getFinalAssistantText(result.messages) || "",
      stage1Model: config.stage1.id,
      stage2Model: p.quick ? undefined : config.stage2.id,
      stage1bModel: config.stage1b?.id,
      stage1cModel: config.stage1c?.id,
      stage1BackupModel: config.stage1Backup?.id,
      isReview: false,
      quick: p.quick ?? false,
      cost: result.usage?.cost ?? 0,
      cwd: ctx.cwd,
    });
    }

    const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);
    let resultText = formatForkResultOutput(result, details);

    // Compare to previous report on same task, if available
    const previous = findPreviousSession(ctx.cwd, p.task);
    if (previous?.resultText && previous.id !== current.id) {
      const diff = computeReportDiff(previous.resultText, getFinalAssistantText(result.messages) || "");
      if (diff.added.length > 0 || diff.removed.length > 0) {
        resultText += "\n\n---\n📊 Changes vs previous report\n\n" + formatReportDiff(diff);
      }
    }

    maybeWarnSessionSize(ctx);

    const reportNote = reportRelPath
      ? `\n\n---\n📄 ${isPlan ? "Plan" : "Report"} saved: ${reportRelPath}\n${isPlan ? "Review the plan before implementing." : "After implementing findings, update this file to track what was done (check off items, add notes). Use /cdev review ${reportRelPath} to get a second opinion."}`
      : "";

    return {
      content: [{ type: "text" as const, text: resultText + reportNote }],
      details: withUiDetails(details, buildReportUiDetails(getFinalAssistantText(result.messages), {
        mode: isPlan ? "plan" : quick ? "quick" : verify ? "verify" : useParallel ? "parallel" : "fork",
        task: p.task,
        reportPath: reportRelPath || undefined,
      })),
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
}
