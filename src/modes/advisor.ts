/**
 * Advisor mode handler for cdev.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { runCdevAdvisor } from "../runner.js";
import { getFinalAssistantText } from "../runner-events.js";
import {
  makeThemedBg, resolveStageProfiles,
} from "../extension-context.js";
import {
  clearProgress, modelLabel,
  formatProgressDetail, checkForkBudget,
} from "./shared-helpers.js";
import { safeDisplayText } from "../text-width.js";

export async function handleAdvisor(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  signal: AbortSignal | undefined,
  themedBg: ReturnType<typeof makeThemedBg>,
  snapshot: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const task = p.task!; // validated by dispatcher
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
  const budget = checkForkBudget(config, ctx.cwd, task,
    askAdvisorOnly ? advisorProfile : profiles.stage1,
    advisorProfile,
    { quick: askAdvisorOnly, snapshot });
  if (!budget.allowed) {
    return {
      content: [{ type: "text" as const, text: budget.error }],
      details: budget.details,
      isError: budget.isError,
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
    question: task,
    forkSessionSnapshotJsonl: snapshot,
    advisorProfile,
    scoutProfile: profiles.stage1,
    customPrompt: config.promptsEnabled ? config.prompts?.advisor : undefined,
    scoutTimeoutMs: config.profileTimeouts?.scout ?? config.scoutTimeoutMs,
    advisorTimeoutMs: config.profileTimeouts?.forge ?? config.forgeTimeoutMs,
    includeScout: !askAdvisorOnly,
    onProgress,
    onUpdate: (update) => {
      const detail = formatProgressDetail(update);
      const activity = detail ? ` · ${detail}` : "";
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🧭 Advisor ${update.stage}…${activity}`)]);
    },
    extensions: config.extensions,
    environment: config.environment,
    offline: config.offline,
    signal,
  });
  clearProgress(ctx);

  const advisorText = getFinalAssistantText(result.messages) || "";
  const advisorCost = (advisorDetails.stage1?.usage?.cost ?? 0) + (advisorDetails.stage2?.usage?.cost ?? 0);
  const slug = task
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);
  const { finalizeForkResult } = await import("./shared-helpers.js");
  const forkRes = await finalizeForkResult({
    ctx,
    config,
    task,
    result,
    details: advisorDetails,
    startTime,
    mode: "advisor",
    isReview: false,
    memory: config.memory && !!advisorText,
    cost: advisorCost,
    report: advisorText
      ? {
          fileName: `advisor-${slug}-${Date.now().toString(36)}.md`,
          title: `Advisor: ${task.slice(0, 80)}`,
          reviewer: advisorProfile.id,
          body: advisorText,
        }
      : undefined,
    suffix: scoutText ? "\n\n---\n🔍 Scout evidence was included in the advisor prompt." : undefined,
    memoryOptions: {
      stage1Model: askAdvisorOnly ? undefined : profiles.stage1.id,
      stage2Model: advisorProfile.id,
      isReview: false,
      quick: askAdvisorOnly,
    },
  });

  return {
    content: [{ type: "text" as const, text: safeDisplayText(forkRes.resultText) }],
    details: forkRes.details,
    isError: forkRes.isError,
  };
}
