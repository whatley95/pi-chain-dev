import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runAutoFork, runCdevReview, runFileReview, runDiffReview } from "./runner.js";
import { getFinalAssistantText } from "./runner-events.js";
import { emptyFailedResult } from "./types.js";
import { saveSession } from "./history.js";
import { indexFindingsAsync, memoryGetTopic, formatTopicDetail, loadMemory, formatMemoryTopics } from "./memory.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  formatResultContent,
  logError,
  checkCostBudget,
  recordForkCost,
} from "./extension-context.js";

export interface AutoForkParamsType {
  task?: string;
  review?: boolean;
  quick?: boolean;
  verify?: boolean;
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
          try { appendFileSync(filePath, appendText, "utf-8"); } catch { /* ignore */ }

          const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
          try {
            mkdirSync(reportsDir, { recursive: true });
            const reviewSlug = `review-${p.reviewFile.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}.md`;
            const standalonePath = join(reportsDir, reviewSlug);
            reportRelPath = `.pi/cdev/reports/${reviewSlug}`;
            writeFileSync(standalonePath, `# Review: ${p.reviewFile}\n\n**Date:** ${reviewDate}\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`, "utf-8");
          } catch { /* ignore */ }
        }

        saveSession(ctx.cwd, `review ${p.reviewFile}`, true, startTime, details, result);
        if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        const reviewCost = result.usage?.cost ?? 0;
        recordForkCost(ctx.cwd, reviewCost);
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
          const { spawnSync } = require("node:child_process");
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
        const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
        mkdirSync(reportsDir, { recursive: true });
        const reportPath = join(reportsDir, reportFileName);
        const reportRelPath = `.pi/cdev/reports/${reportFileName}`;
        if (reviewText && !result.errorMessage) {
          try {
            writeFileSync(reportPath, `# Diff Review: ${diffSpec}\n\n**Date:** ${new Date().toISOString().split("T")[0]}\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`, "utf-8");
          } catch { /* ignore */ }
        }

        saveSession(ctx.cwd, `review diff ${diffSpec}`, true, startTime, details, result);
        if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        const diffReviewCost = result.usage?.cost ?? 0;
        recordForkCost(ctx.cwd, diffReviewCost);
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
      let reviewReportPath = "";
      if (reviewText && !result.errorMessage) {
        try {
          const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
          mkdirSync(reportsDir, { recursive: true });
          const reviewSlug = `session-review-${Date.now().toString(36)}.md`;
          const standalonePath = join(reportsDir, reviewSlug);
          reviewReportPath = `.pi/cdev/reports/${reviewSlug}`;
          writeFileSync(standalonePath, `# Session Review\n\n**Date:** ${new Date().toISOString().split("T")[0]}\n**Reviewer:** ${details.stage2?.model ?? "?"}\n\n${reviewText}\n`, "utf-8");
        } catch { /* ignore */ }
      }

      saveSession(ctx.cwd, reviewTask, true, startTime, details, result);
      if (result.errorMessage) logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
      const sessionReviewCost = result.usage?.cost ?? 0;
      recordForkCost(ctx.cwd, sessionReviewCost);
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
        content: [{ type: "text" as const, text: formatResultContent(result, details) + suffix }],
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
    const verify = p.verify ?? false;

    const estimatedCost = 0;
    const budgetCheck = checkCostBudget(config, ctx.cwd, estimatedCost);
    if (!budgetCheck.allowed) {
      return {
        content: [{ type: "text" as const, text: `cdev budget error: ${budgetCheck.reason}` }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }

    const onProgress = (stage: string, model: string) => {
      if (stage === "scout") {
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔍 Scout exploring…  (${model})`)]);
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

    saveSession(ctx.cwd, p.task, false, startTime, details, result);

    const slugBase = p.task
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
          writeFileSync(reportPath, `# cdev report\n\n**Task:** ${p.task}\n**Scout:** ${details.stage1?.model ?? "?"}\n**Forge:** ${details.stage2?.model ?? "?"}\n**Date:** ${new Date().toISOString().split("T")[0]}\n\n---\n\n${reportText}\n`, "utf-8");
        } catch { /* ignore */ }
      }
    }
    if (result.errorMessage) logError(ctx.cwd, "full-mode", new Error(result.errorMessage));
    const forkCost = result.usage?.cost ?? 0;
    recordForkCost(ctx.cwd, forkCost);
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
}
