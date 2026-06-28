/**
 * Research mode handler for cdev.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { runCdevResearch } from "../runner.js";
import { writeReportFile } from "../report.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession, findPreviousSession } from "../history.js";
import {
  logError, recordForkCost, maybeNotifyCostAlert, maybeWarnSessionSize,
  formatForkResultOutput, makeThemedBg, withAuditGuard, resolveStageProfiles,
} from "../extension-context.js";
import { indexFindingsAsync } from "../memory.js";
import {
  clearProgress, withUiDetails, buildReportUiDetails,
  formatProgressDetail, checkForkBudget,
} from "./shared-helpers.js";
import { computeReportDiff, formatReportDiff } from "../json-extract.js";
import { safeDisplayText } from "../text-width.js";

export async function handleResearch(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  signal: AbortSignal | undefined,
  themedBg: ReturnType<typeof makeThemedBg>,
  snapshot: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const task = p.task!; // validated by dispatcher
  const auditedTask = withAuditGuard(task);
  const profiles = resolveStageProfiles(config);
  const researchProfile = config.research ?? profiles.stage1;
  if (!researchProfile.provider || !researchProfile.id) {
    return {
      content: [{ type: "text" as const, text: "cdev research error: Research model not configured. Use /cdev-model." }],
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }

  const budget = checkForkBudget(config, ctx.cwd, auditedTask,
    researchProfile, researchProfile,
    { quick: true, snapshot });
  if (!budget.allowed) {
    return {
      content: [{ type: "text" as const, text: budget.error }],
      details: budget.details,
      isError: budget.isError,
    };
  }

  const onProgress = (stage: string, model: string) => {
    const icon = stage === "scout" ? "🔍" : "📚";
    const label = stage === "scout" ? "Scout researching" : "Analyzing";
    ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label}…  (${model})`)]);
  };
  onProgress("research", researchProfile.id);
  const startTime = Date.now();
  const { result, details } = await runCdevResearch({
    cwd: ctx.cwd,
    task: auditedTask,
    forkSessionSnapshotJsonl: snapshot,
    stageProfile: researchProfile,
    customPrompt: config.promptsEnabled ? config.prompts?.research : undefined,
    stageTimeoutMs: config.profileTimeouts?.research ?? config.scoutTimeoutMs,
    onProgress,
    onUpdate: (update) => {
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `📚 Research ${update.stage}… ${formatProgressDetail(update)}`)]);
    },
    extensions: config.extensions,
    environment: config.environment,
    offline: config.offline,
    signal,
  });
  clearProgress(ctx);

  const current = saveSession(ctx.cwd, task, false, startTime, details, result);
  const researchText = getFinalAssistantText(result.messages) || "";
  const researchCost = result.usage?.cost ?? 0;
  recordForkCost(ctx.cwd, researchCost);
  maybeNotifyCostAlert(ctx, config);
  maybeWarnSessionSize(ctx);

  let researchReportPath = "";
  if (researchText && !result.errorMessage) {
    const slug = task
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 60);
    const { reportRelPath: savedPath } = writeReportFile({
      cwd: ctx.cwd,
      fileName: `research-${slug}-${Date.now().toString(36)}.md`,
      title: `Research: ${task.slice(0, 80)}`,
      reviewer: researchProfile.id,
      body: researchText,
    });
    researchReportPath = savedPath;
  }

  if (result.errorMessage) {
    logError(ctx.cwd, "research", new Error(result.errorMessage));
  }
  if (config.memory && researchText) {
    indexFindingsAsync({
      task,
      resultText: researchText,
      stage1Model: profiles.stage1.id,
      stage2Model: researchProfile.id,
      isReview: false,
      quick: true,
      cost: result.usage?.cost ?? 0,
      cwd: ctx.cwd,
    });
  }

  const isError = result.exitCode > 0 && !researchText;
  let resultText = formatForkResultOutput(result, details);
  if (researchReportPath) {
    resultText += `\n\n---\n📄 Research report saved: ${researchReportPath}`;
  }

  const previous = findPreviousSession(ctx.cwd, task);
  if (previous?.resultText && previous.id !== current.id) {
    const diff = computeReportDiff(previous.resultText, getFinalAssistantText(result.messages) || "");
    if (diff.added.length > 0 || diff.removed.length > 0) {
      resultText += "\n\n---\n📊 Changes vs previous research\n\n" + formatReportDiff(diff);
    }
  }

  return {
    content: [{ type: "text" as const, text: safeDisplayText(resultText) }],
    details: withUiDetails(details, buildReportUiDetails(researchText, {
      mode: "research",
      task,
      reportPath: researchReportPath || undefined,
    })),
    isError,
  };
}
