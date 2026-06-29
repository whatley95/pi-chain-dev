/**
 * YOLO review-fix loop mode handler for cdev.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { runYoloLoop } from "../runner.js";
import { getFinalAssistantText } from "../runner-events.js";
import {
  logError, recordForkCost, maybeNotifyCostAlert, maybeWarnSessionSize,
  formatCost, makeThemedBg, resolveStageProfiles,
} from "../extension-context.js";
import { saveSession } from "../history.js";
import { indexFindingsAsync } from "../memory.js";
import {
  clearProgress, withUiDetails,
  formatProgressDetail, checkForkBudget,
} from "./shared-helpers.js";
import { normalizeYoloConfig } from "../types.js";
import { safeDisplayText } from "../text-width.js";

export async function handleYolo(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  signal: AbortSignal | undefined,
  themedBg: ReturnType<typeof makeThemedBg>,
  snapshot: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const task = p.task!; // validated by dispatcher
  const yolo = normalizeYoloConfig(config.yolo);
  const profiles = resolveStageProfiles(config);
  const budget = checkForkBudget(config, ctx.cwd, task,
    profiles.stage1, profiles.stage2,
    { snapshot, costMultiplier: 1 + yolo.maxRounds * 2, costLabel: " YOLO loop", unitLabel: `(1 initial fork + up to ${yolo.maxRounds} review rounds + ${yolo.maxRounds} fix rounds)` });
  if (!budget.allowed) {
    return {
      content: [{ type: "text" as const, text: budget.error }],
      details: budget.details,
      isError: budget.isError,
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

  const onYoloProgress = (stage: string, model: string, round?: number) => {
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

  const startTime = Date.now();
  const yoloResult = await runYoloLoop({
    cwd: ctx.cwd,
    task,
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
    scoutTimeoutMs: config.profileTimeouts?.scout ?? config.scoutTimeoutMs,
    forgeTimeoutMs: config.profileTimeouts?.forge ?? config.forgeTimeoutMs,
    yoloReviewTimeoutMs: config.profileTimeouts?.yoloReview ?? config.forgeTimeoutMs,
    yoloFixTimeoutMs: config.profileTimeouts?.yoloFix ?? config.forgeTimeoutMs,
    onProgress: onYoloProgress,
    onUpdate: (update) => {
      const detail = formatProgressDetail(update);
      const activity = detail ? ` · ${detail}` : "";
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔧 YOLO ${update.stage}…${activity || " · working…"}`)]);
    },
    extensions: config.extensions,
    environment: config.environment,
    offline: config.offline,
    signal,
  });
  clearProgress(ctx);

  saveSession(ctx.cwd, task, false, startTime, yoloResult.initial.details, yoloResult.initial.result);

  if (yoloResult.initial.result.errorMessage) {
    logError(ctx.cwd, "yolo-initial", new Error(yoloResult.initial.result.errorMessage));
  }
  for (const round of yoloResult.rounds) {
    if (round.review.result.errorMessage) {
      logError(ctx.cwd, "yolo-review", new Error(round.review.result.errorMessage));
    }
  }

  recordForkCost(ctx.cwd, yoloResult.totalCost);
  maybeNotifyCostAlert(ctx, config);
  maybeWarnSessionSize(ctx);
  if (config.memory) {
    indexFindingsAsync({
      task,
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
  const reportBody = yoloResult.finalReportText
    ? `\n\n---\n\n## Final report\n\n${yoloResult.finalReportText}`
    : "";

  return {
    content: [{ type: "text" as const, text: safeDisplayText(summary + reportBody) }],
    details: withUiDetails(
      yoloResult.rounds.length > 0 ? yoloResult.rounds[yoloResult.rounds.length - 1].review.details : yoloResult.initial.details,
      {
        mode: "yolo",
        task,
        reportPath: yoloResult.finalReportPath,
        status: yoloResult.finalVerdict === "pass" ? "ok" : yoloResult.finalVerdict === "blocked" ? "blocked" : "needs-work",
      },
    ),
    isError: yoloResult.finalVerdict !== "pass",
  };
}
