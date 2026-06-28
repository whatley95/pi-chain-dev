/**
 * Recall mode handler for cdev — retrieves previously indexed findings.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { memoryGetTopic, formatTopicDetail, loadMemory, formatMemoryTopics } from "../memory.js";
import { safeDisplayText } from "../text-width.js";

export async function handleRecall(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
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
        content: [{ type: "text" as const, text: safeDisplayText(`🧠 cdev memory hit: ${p.recall}\n\n${detail}`) }],
        details: { stage1: null, stage2: null, ui: { mode: "recall", task: p.recall } },
      };
    }
    return {
      content: [{ type: "text" as const, text: `🧠 cdev memory miss: no findings for "${p.recall}".` }],
      details: { stage1: null, stage2: null, ui: { mode: "recall", task: p.recall } },
    };
  }
  const memory = loadMemory(ctx.cwd);
  const listing = formatMemoryTopics(memory);
  return {
    content: [{ type: "text" as const, text: safeDisplayText(`🧠 cdev memory\n\n${listing}`) }],
    details: { stage1: null, stage2: null, ui: { mode: "recall" } },
  };
}
