import type { CdevTopic } from "../types.js";
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
  memoryRename,
  memoryDeleteFinding,
  memoryGetTopic,
  memoryTopicCount,
  mergeSimilarTopics,
  topicHasStaleFindings,
} from "../memory.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  logError,
} from "../extension-context.js";
import { writeAgentSetting } from "../settings-helpers.js";

async function refreshMemoryTopic(
  ctx: ExtensionContext,
  config: AutoForkConfig,
  topic: string,
  entry: CdevTopic,
): Promise<CdevTopic | null> {
  const profiles = resolveStageProfiles(config);
  if (profiles.warning) {
    ctx.ui.notify(profiles.warning, "warn");
    return null;
  }
  ctx.ui.notify(`Refreshing memory topic "${topic}" (stage 1 → stage 2)...`, "info");
  try {
    const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager, config.modelContextLimit);
    if (!snapshot) { ctx.ui.notify("Cannot snapshot session.", "error"); return null; }

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
      scoutTimeoutMs: config.profileTimeouts?.scout ?? config.scoutTimeoutMs,
      forgeTimeoutMs: config.profileTimeouts?.forge ?? config.forgeTimeoutMs,
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
      return memoryGetTopic(ctx.cwd, topic) ?? entry;
    }
    return null;
  } catch (err) {
    logError(ctx.cwd, "memory-refresh", err);
    ctx.ui.notify(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  }
}

export async function handleMemory(args: string, ctx: ExtensionContext, config: AutoForkConfig): Promise<boolean> {
  const trimmed = args.trim();
  const lower = trimmed.toLowerCase();

  const recallMatch = trimmed.match(/^recall(?:\s+(.+))?$/i);
  if (recallMatch) {
    if (!config.memory) {
      ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
      return true;
    }
    const topic = recallMatch[1]?.trim();
    if (topic) {
      const entry = memoryGetTopic(ctx.cwd, topic);
      if (entry) {
        ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
        if (config.memoryAutoRefresh && topicHasStaleFindings(entry, ctx.cwd)) {
          const updated = await refreshMemoryTopic(ctx, config, topic, entry);
          if (updated) ctx.ui.notify(formatTopicDetail(updated, ctx.cwd), "info");
        }
      } else {
        ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
      }
    } else {
      const memory = loadMemory(ctx.cwd);
      ctx.ui.notify(formatMemoryTopics(memory), "info");
    }
    return true;
  }

  const viewMatch = trimmed.match(/^view(?:\s+(.+))?$/i);
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

  if (lower === "memory clear") {
    memoryClear(ctx.cwd);
    ctx.ui.notify("Cleared all cdev project memory.", "info");
    return true;
  }

  const memoryForgetMatch = trimmed.match(/^memory forget\s+(.+)$/i);
  if (memoryForgetMatch) {
    const topic = memoryForgetMatch[1].trim();
    const removed = memoryForget(ctx.cwd, topic);
    if (removed) ctx.ui.notify(`Removed memory for topic "${topic}".`, "info");
    else ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
    return true;
  }

  if (lower === "memory merge") {
    const merged = mergeSimilarTopics(ctx.cwd);
    if (merged.length > 0) {
      ctx.ui.notify(`Merged similar topics:\n${merged.join("\n")}`, "info");
    } else {
      ctx.ui.notify("No similar topics to merge.", "info");
    }
    return true;
  }

  const memoryRefreshMatch = trimmed.match(/^memory refresh\s+(.+)$/i);
  if (memoryRefreshMatch) {
    if (!config.memory) {
      ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
      return true;
    }
    const topic = memoryRefreshMatch[1].trim();
    const entry = memoryGetTopic(ctx.cwd, topic);
    if (!entry) {
      ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
      return true;
    }
    const updated = await refreshMemoryTopic(ctx, config, topic, entry);
    if (updated) {
      ctx.ui.notify(formatTopicDetail(updated, ctx.cwd), "info");
    } else {
      ctx.ui.notify(`Refresh completed but produced no output.`, "warn");
    }
    return true;
  }

  if (lower === "memory auto-refresh on" || lower === "memory auto-refresh off") {
    const enable = lower === "memory auto-refresh on";
    writeAgentSetting("memoryAutoRefresh", enable);
    ctx.ui.notify(`Memory auto-refresh ${enable ? "ON" : "OFF"}`, "info");
    return true;
  }

  if (lower === "memory on" || lower === "memory off") {
    const enable = lower === "memory on";
    writeAgentSetting("memory", enable);
    ctx.ui.notify(`Project memory ${enable ? "ON" : "OFF"}`, "info");
    return true;
  }

  // ── Subcommand: memory rename <old> <new> ──
  const renameMatch = trimmed.match(/^memory rename\s+(\S+)\s+(\S+)$/i);
  if (renameMatch) {
    const oldName = renameMatch[1].trim();
    const newName = renameMatch[2].trim();
    if (!oldName || !newName) {
      ctx.ui.notify("Usage: /cdev memory rename <old-topic> <new-topic>", "warn");
      return true;
    }
    const ok = memoryRename(ctx.cwd, oldName, newName);
    if (ok) ctx.ui.notify(`Renamed topic "${oldName}" → "${newName}".`, "info");
    else ctx.ui.notify(`Topic "${oldName}" not found.`, "warn");
    return true;
  }

  // ── Subcommand: memory delete <topic> <index> ──
  const deleteMatch = trimmed.match(/^memory delete\s+(\S+)\s+(\d+)$/i);
  if (deleteMatch) {
    const topic = deleteMatch[1].trim();
    const index = parseInt(deleteMatch[2], 10);
    if (!topic || index < 1) {
      ctx.ui.notify("Usage: /cdev memory delete <topic> <#n>", "warn");
      return true;
    }
    const ok = memoryDeleteFinding(ctx.cwd, topic, index);
    if (ok) ctx.ui.notify(`Deleted finding #${index} from topic "${topic}".`, "info");
    else ctx.ui.notify(`Topic "${topic}" has no finding #${index}.`, "warn");
    return true;
  }

  return false;
}

export { memoryTopicCount };
