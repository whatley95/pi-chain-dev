/**
 * Advisor mode handler for cdev.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { runCdevAdvisor } from "../runner.js";
import { writeReportFile } from "../report.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession, findPreviousSession } from "../history.js";
import {
  recordForkCost, maybeNotifyCostAlert, maybeWarnSessionSize,
  formatForkResultOutput, estimateForkCost, checkCostBudget, formatCost,
  makeThemedBg, resolveStageProfiles,
} from "../extension-context.js";
import {
  clearProgress, withUiDetails, buildReportUiDetails, modelLabel,
  formatProgressDetail,
} from "./shared-helpers.js";
import { computeReportDiff, formatReportDiff } from "../json-extract.js";

export async function handleAdvisor(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  signal: AbortSignal | undefined,
  themedBg: ReturnType<typeof makeThemedBg>,
  snapshot: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const profiles = resolveStageProfiles(config);
  const advisorProfile = config.advisor ?? profiles.stage2;
  if (!advisorProfile.provider || !advisorProfile.id) {
    return {
      content: [{ type: "text" as const, text: "cdev advisor error: Advisor model not configured. Use /cdev-model." }],
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }

  const askAdvisorOnly = p.askAdvisor === true;
  const estimate = estimateForkCost({
    task: p.task!,
    stage1Profile: askAdvisorOnly ? advisorProfile : profiles.stage1,
    stage2Profile: advisorProfile,
    quick: askAdvisorOnly,
    forkSessionSnapshotJsonl: snapshot ?? undefined,
  });
  const budgetCheck = checkCostBudget(config, ctx.cwd, estimate.cost);
  if (!budgetCheck.allowed) {
    const budgetMsg = `cdev budget error: ${budgetCheck.reason}\nEstimated: ~${formatCost(estimate.cost)} (${estimate.inputTokens} input / ${estimate.outputTokens} output tokens)`;
    return {
      content: [{ type: "text" as const, text: budgetMsg }],
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }

  const onProgress = (stage: "scout" | "advisor", model: string) => {
    const icon = stage === "scout" ? "🔍" : "🧭";
    const label = stage === "scout" ? "Scout gathering evidence" : "Advisor reasoning";
    ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label}…  (${model})`)]);
  };
  onProgress(askAdvisorOnly ? "advisor" : "scout",
    modelLabel(askAdvisorOnly ? advisorProfile : profiles.stage1));
  const startTime = Date.now();
  const { result, details: advisorDetails, scoutText } = await runCdevAdvisor({
    cwd: ctx.cwd,
    question: p.task!,
    forkSessionSnapshotJsonl: snapshot,
    advisorProfile,
    scoutProfile: profiles.stage1,
    customPrompt: config.promptsEnabled ? config.prompts?.advisor : undefined,
    scoutTimeoutMs: config.profileTimeouts?.scout ?? config.scoutTimeoutMs,
    advisorTimeoutMs: config.profileTimeouts?.forge ?? config.forgeTimeoutMs,
    includeScout: !askAdvisorOnly,
    onProgress,
    onUpdate: (update) => {
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🧭 Advisor ${update.stage}… ${formatProgressDetail(update)}`)]);
    },
    extensions: config.extensions,
    environment: config.environment,
    offline: config.offline,
    signal,
  });
  clearProgress(ctx);

  const current = saveSession(ctx.cwd, p.task!, false, startTime, advisorDetails, result);
  const advisorText = getFinalAssistantText(result.messages) || "";
  const advisorCost = (advisorDetails.stage1?.usage?.cost ?? 0) + (advisorDetails.stage2?.usage?.cost ?? 0);
  recordForkCost(ctx.cwd, advisorCost);
  maybeNotifyCostAlert(ctx, config);
  maybeWarnSessionSize(ctx);

  let reportRelPath = "";
  if (advisorText && !result.errorMessage) {
    const slug = p.task!
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 60);
    const { reportRelPath: savedPath } = writeReportFile({
      cwd: ctx.cwd,
      fileName: `advisor-${slug}-${Date.now().toString(36)}.md`,
      title: `Advisor: ${p.task!.slice(0, 80)}`,
      reviewer: advisorProfile.id,
      body: advisorText,
    });
    reportRelPath = savedPath;
  }

  const scoutNote = scoutText ? "\n\n---\n🔍 Scout evidence was included in the advisor prompt." : "";
  const reportNote = reportRelPath ? `\n\n---\n📄 Advisor report saved: ${reportRelPath}` : "";
  let resultText = formatForkResultOutput(result, advisorDetails) + scoutNote + reportNote;

  const previous = findPreviousSession(ctx.cwd, p.task!);
  if (previous?.resultText && previous.id !== current.id) {
    const diff = computeReportDiff(previous.resultText, advisorText);
    if (diff.added.length > 0 || diff.removed.length > 0) {
      resultText += "\n\n---\n📊 Changes vs previous advisor run\n\n" + formatReportDiff(diff);
    }
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details: withUiDetails(advisorDetails, buildReportUiDetails(advisorText, {
      mode: "advisor",
      task: p.task!,
      reportPath: reportRelPath || undefined,
    })),
    isError: result.exitCode > 0 && !advisorText,
  };
}
