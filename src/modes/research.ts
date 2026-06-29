/**
 * Research mode handler for cdev.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { runCdevResearch } from "../runner.js";
import { getFinalAssistantText } from "../runner-events.js";
import {
  formatForkResultOutput, makeThemedBg, withAuditGuard, resolveStageProfiles,
} from "../extension-context.js";
import {
  clearProgress,
  formatProgressDetail, checkForkBudget,
} from "./shared-helpers.js";
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
      const detail = formatProgressDetail(update);
      const activity = detail ? ` · ${detail}` : "";
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `📚 Research ${update.stage}…${activity}`)]);
    },
    extensions: config.extensions,
    environment: config.environment,
    offline: config.offline,
    signal,
  });
  clearProgress(ctx);

  const researchText = getFinalAssistantText(result.messages) || "";
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
    details,
    startTime,
    mode: "research",
    isReview: false,
    memory: config.memory && !!researchText,
    report: researchText
      ? {
          fileName: `research-${slug}-${Date.now().toString(36)}.md`,
          title: `Research: ${task.slice(0, 80)}`,
          reviewer: researchProfile.id,
          body: researchText,
        }
      : undefined,
    memoryOptions: {
      stage1Model: profiles.stage1.id,
      stage2Model: researchProfile.id,
      isReview: false,
      quick: true,
    },
  });

  const resultText = formatForkResultOutput(result, details) + (forkRes.reportPath
    ? `\n\n---\n📄 Research report saved: ${forkRes.reportPath}`
    : "");

  return {
    content: [{ type: "text" as const, text: safeDisplayText(resultText) }],
    details: forkRes.details,
    isError: forkRes.isError,
  };
}
