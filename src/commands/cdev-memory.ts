import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutoForkConfig } from "../config.js";
import { runAutoFork } from "../fork-orchestrator.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession } from "../history.js";
import {
  indexFindingsAsync,
  loadMemory,
  formatMemoryTopics,
  formatTopicDetail,
  memoryClear,
  memoryForget,
  memoryGetTopic,
  memoryTopicCount,
  mergeSimilarTopics,
} from "../memory.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  logError,
} from "../extension-context.js";
import { writeAgentSetting } from "../settings-helpers.js";

export async function handleMemory(args: string, ctx: ExtensionContext, config: AutoForkConfig): Promise<boolean> {
  const trimmed = args.trim();

  const recallMatch = trimmed.match(/^recall(?:\s+(.+))?$/);
  if (recallMatch) {
    if (!config.memory) {
      ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
      return true;
    }
    const topic = recallMatch[1]?.trim();
    if (topic) {
      const entry = memoryGetTopic(ctx.cwd, topic);
      if (entry) ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
      else ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
    } else {
      const memory = loadMemory(ctx.cwd);
      ctx.ui.notify(formatMemoryTopics(memory), "info");
    }
    return true;
  }

  const viewMatch = trimmed.match(/^view(?:\s+(.+))?$/);
  if (viewMatch) {
    const topic = viewMatch[1]?.trim();
    if (topic) {
      const entry = memoryGetTopic(ctx.cwd, topic);
      if (entry) ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
      else ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
    } else {
      const memory = loadMemory(ctx.cwd);
      ctx.ui.notify(formatMemoryTopics(memory), "info");
    }
    return true;
  }

  if (trimmed === "memory clear") {
    memoryClear(ctx.cwd);
    ctx.ui.notify("Cleared all cdev project memory.", "info");
    return true;
  }

  const memoryForgetMatch = trimmed.match(/^memory forget\s+(.+)$/);
  if (memoryForgetMatch) {
    const topic = memoryForgetMatch[1].trim();
    const removed = memoryForget(ctx.cwd, topic);
    if (removed) ctx.ui.notify(`Removed memory for topic "${topic}".`, "info");
    else ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
    return true;
  }

  if (trimmed === "memory merge") {
    const merged = mergeSimilarTopics(ctx.cwd);
    if (merged.length > 0) {
      ctx.ui.notify(`Merged similar topics:\n${merged.join("\n")}`, "info");
    } else {
      ctx.ui.notify("No similar topics to merge.", "info");
    }
    return true;
  }

  const memoryRefreshMatch = trimmed.match(/^memory refresh\s+(.+)$/);
  if (memoryRefreshMatch) {
    if (!config.memory) {
      ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
      return true;
    }
    const profiles = resolveStageProfiles(config);
    if (profiles.warning) {
      ctx.ui.notify(profiles.warning, "warn");
      return true;
    }
    const topic = memoryRefreshMatch[1].trim();
    const entry = memoryGetTopic(ctx.cwd, topic);
    if (!entry) {
      ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
      return true;
    }

    ctx.ui.notify(`Refreshing memory topic "${topic}" (stage 1 → stage 2)...`, "info");
    try {
      const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
      if (!snapshot) { ctx.ui.notify("Cannot snapshot session.", "error"); return true; }

      const filesList = entry.files.slice(0, 15).join(", ");
      const previousFindings = entry.findings.slice(0, 3).map((f: { text: string }) => `- ${f.text}`).join("\n");
      const refreshTask = withAuditGuard(
        `Re-explore the "${topic}" topic in this project. Update our understanding based on the current code state.\n\nPreviously tracked files:\n${filesList}\n\nRecent findings:\n${previousFindings}\n\nFocus on what has changed and what is still accurate. Return updated findings, evidence, and action items.`
      );

      const themedBg = makeThemedBg(ctx, config.themed);
      const refreshStartTime = Date.now();
      const onProgress = (stage: string, model: string) => {
        const icon = stage === "scout" ? "🔍" : "⚒️";
        const label = stage === "scout" ? "Scout" : "Forge";
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} refreshing ${topic}…  (${model})`)]);
      };
      onProgress("scout", profiles.stage1.id);
      const { result, details: refreshDetails } = await runAutoFork({
        cwd: ctx.cwd,
        task: refreshTask,
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

      saveSession(ctx.cwd, refreshTask, false, refreshStartTime, refreshDetails, result);
      if (result.errorMessage) logError(ctx.cwd, "memory-refresh", new Error(result.errorMessage));

      const finalText = getFinalAssistantText(result.messages);
      if (finalText) {
        indexFindingsAsync({
          task: `refresh ${topic}`,
          resultText: finalText,
          stage1Model: refreshDetails.stage1?.model ?? profiles.stage1.id,
          stage2Model: refreshDetails.stage2?.model ?? profiles.stage2.id,
          isReview: false,
          quick: false,
          cost: result.usage?.cost ?? 0,
          cwd: ctx.cwd,
        });
        const updated = memoryGetTopic(ctx.cwd, topic);
        ctx.ui.notify(formatTopicDetail(updated ?? entry, ctx.cwd), "info");
      } else {
        ctx.ui.notify(`Refresh completed but produced no output.`, "warn");
      }
    } catch (err) {
      logError(ctx.cwd, "memory-refresh", err);
      ctx.ui.notify(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return true;
  }

  if (trimmed === "memory on" || trimmed === "memory off") {
    const enable = trimmed === "memory on";
    writeAgentSetting("memory", enable);
    ctx.ui.notify(`Project memory ${enable ? "ON" : "OFF"}`, "info");
    return true;
  }

  return false;
}

export { memoryTopicCount };
