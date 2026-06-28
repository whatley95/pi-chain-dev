/**
 * Review mode handler for cdev — file review, diff review, session review.
 */
import { readFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPathUnderCwd } from "../path-guards.js";
import { runCdevReview, runFileReview, runDiffReview } from "../runner.js";
import { writeReportFile } from "../report.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession } from "../history.js";
import {
  logError, recordForkCost, maybeNotifyCostAlert, maybeWarnSessionSize,
  formatForkResultOutput, makeThemedBg,
} from "../extension-context.js";
import { indexFindingsAsync } from "../memory.js";
import { formatProgressDetail, clearProgress, withUiDetails, buildReportUiDetails, checkSessionSnapshot, isCompactTrigger, formatCompactMessage, detectVcs, runDiff } from "./shared-helpers.js";
import type { AutoForkParamsType } from "../tool.js";

export async function handleReview(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  signal: AbortSignal | undefined,
  themedBg: ReturnType<typeof makeThemedBg>,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
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
          stageTimeoutMs: config.profileTimeouts?.review ?? config.forgeTimeoutMs,
          onProgress,
          onUpdate: (update) => {
            ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge reviewing ${p.reviewFile}…  ${formatProgressDetail(update)}`)]);
          },
          extensions: config.extensions,
          environment: config.environment,
          offline: config.offline,
          signal,
        });
        clearProgress(ctx);
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
        if (/^(?:[a-zA-Z]:)?[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(diffSpec)) {
          return {
            content: [{ type: "text" as const, text: `cdev review error: diffSpec must not contain path traversal or absolute paths: ${diffSpec}` }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        let diffContent: string;
        try {
          const vcs = detectVcs(ctx.cwd);
          if (!vcs) {
            return {
              content: [{ type: "text" as const, text: `cdev review error: '${ctx.cwd}' is not inside a git or svn repository. Use /cdev review <path> to review a file, or run this command from a version-controlled directory.` }],
              details: { stage1: null, stage2: null },
              isError: true,
            };
          }
          const diffResult = runDiff(ctx.cwd, diffSpec, vcs);
          if (diffResult.status !== 0) {
            const errMsg = String(diffResult.stderr).trim().slice(0, 200) || `diff exited ${diffResult.status}`;
            throw new Error(errMsg);
          }
          diffContent = String(diffResult.stdout);
          if (!String(diffContent).trim()) {
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
          stageTimeoutMs: config.profileTimeouts?.review ?? config.forgeTimeoutMs,
          onProgress,
          onUpdate: (update) => {
            ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge reviewing diff ${diffSpec}…  ${formatProgressDetail(update)}`)]);
          },
          extensions: config.extensions,
          environment: config.environment,
          offline: config.offline,
          signal,
        });
        clearProgress(ctx);
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
        stageTimeoutMs: config.profileTimeouts?.review ?? config.forgeTimeoutMs,
        customReviewPrompt: config.promptsEnabled ? config.prompts?.review : undefined,
        onProgress,
        onUpdate: (update) => {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge reviewing…  ${formatProgressDetail(update)}`)]);
        },
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal,
      });
      clearProgress(ctx);
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
};
