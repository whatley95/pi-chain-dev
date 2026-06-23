import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runAutoFork, runCdevReview, runFileReview, runDiffReview, formatForkResultOutput, computeReportDiff, formatReportDiff, runYoloLoop } from "./runner.js";
import { writeReportFile } from "./report.js";
import { getFinalAssistantText } from "./runner-events.js";
import { emptyFailedResult, normalizeYoloConfig } from "./types.js";
import { saveSession, findPreviousSession } from "./history.js";
import { indexFindingsAsync, memoryGetTopic, formatTopicDetail, loadMemory, formatMemoryTopics } from "./memory.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  logError,
  checkCostBudget,
  recordForkCost,
  estimateForkCost,
  formatCost,
  maybeWarnSessionSize,
  maybeNotifyCostAlert,
} from "./extension-context.js";

export interface AutoForkParamsType {
  task?: string;
  review?: boolean;
  quick?: boolean;
  verify?: boolean;
  yolo?: boolean;
  recall?: string;
  reviewFile?: string;
  diffSpec?: string;
}

export async function executeCdevTool(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const p = params as AutoForkParamsType;
  try {
    const config = loadConfig(ctx.cwd);
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
            details: { stage1: null, stage2: null },
          };
        }
        return {
          content: [{ type: "text" as const, text: `🧠 cdev memory miss: no findings for "${p.recall}".` }],
          details: { stage1: null, stage2: null },
        };
      }
      const memory = loadMemory(ctx.cwd);
      const listing = formatMemoryTopics(memory);
      return {
        content: [{ type: "text" as const, text: `🧠 cdev memory\n\n${listing}` }],
        details: { stage1: null, stage2: null },
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
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} reviewing ${p.reviewFile}…  (${model})`)]);
        };
        onProgress("forge", reviewProfile.id);
        const startTime = Date.now();
        const { result, details } = await runFileReview({
          cwd: ctx.cwd,
          filePath: p.reviewFile,
          fileContent,
          stageProfile: reviewProfile,
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
        const reviewDate = new Date().toISOString().split("T")[0];
        let reportRelPath = p.reviewFile;
        if (reviewText && !result.errorMessage) {
          const appendText = `\n\n---\n\n## Review (${reviewDate})\n\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`;
          const reviewSlug = `review-${p.reviewFile.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}.md`;
          const { reportRelPath: standaloneRel } = writeReportFile({
            cwd: ctx.cwd,
            fileName: reviewSlug,
            title: `Review: ${p.reviewFile}`,
            reviewer: details.stage2?.model ?? "?",
            body: reviewText,
            appendTo: filePath,
            appendBody: appendText,
          });
          reportRelPath = standaloneRel;
        }

        saveSession(ctx.cwd, `review ${p.reviewFile}`, true, startTime, details, result);
        if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        const reviewCost = result.usage?.cost ?? 0;
        recordForkCost(ctx.cwd, reviewCost);
        maybeNotifyCostAlert(ctx, config);
        maybeWarnSessionSize(ctx);
        if (config.memory) {
          indexFindingsAsync({
            task: `review ${p.reviewFile}`,
            resultText: getFinalAssistantText(result.messages) || "",
            stage2Model: reviewProfile.id,
            isReview: true,
            quick: false,
            cost: result.usage?.cost ?? 0,
            cwd: ctx.cwd,
          });
        }
        const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);
        const reviewOutput = formatForkResultOutput(result, details);
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
          ? `\n\n---\n⚠️  Review found issues. Read the updated report at ${p.reviewFile}\nand address the new Action Items in the ## Review section.\n📄 Standalone review: ${reportRelPath}\nCheck them off in the report file when done.`
          : `\n\n---\n✅ Review passed. Report updated at ${p.reviewFile}\n📄 Standalone review: ${reportRelPath}`;

        return {
          content: [{ type: "text" as const, text: reviewOutput + actionNote }],
          details,
          isError,
        };
      }

      // Diff review
      if (typeof p.diffSpec === "string" && p.diffSpec.trim()) {
        const diffSpec = p.diffSpec.trim();
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
          ? `\n\n---\n⚠️ Diff review found issues. Report saved at ${reportRelPath}`
          : `\n\n---\n✅ Diff review complete. Report saved at ${reportRelPath}`;

        return {
          content: [{ type: "text" as const, text: reviewOutput + actionNote }],
          details,
          isError,
        };
      }

      // Session review
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
        details,
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

    const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
    if (!snapshot) {
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

    const quick = p.quick ?? false;
    const verify = p.verify ?? (config.autoVerify && !p.quick);

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
        yoloConfig: yolo,
        reviewProfile,
        fixProfile,
        customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
        customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
        customReviewPrompt: config.promptsEnabled ? config.prompts?.review : undefined,
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
        details: yoloResult.rounds.length > 0 ? yoloResult.rounds[yoloResult.rounds.length - 1].review.details : yoloResult.initial.details,
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

    const onProgress = (stage: string, model: string) => {
      if (stage === "scout") {
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${verify ? "🔍🔍" : "🔍"} Scout exploring…  (${model})`)]);
      } else {
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge synthesizing…  (${model})`)]);
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
      stage2Profile: profiles.stage2,
      customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
      customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
      quick,
      verify,
      onProgress,
      onUpdate: (update) => {
        const icon = update.stage.includes("exploration") || update.stage === "scout" ? "🔍" : "⚒️";
        const label = update.stage.includes("exploration") || update.stage === "scout" ? "Scout" : "Forge";
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
          title: "cdev report",
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
}
