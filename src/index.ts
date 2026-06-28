/**
 * pi-chain-dev Extension
 *
 * Entry point that wires together the cdev tool, /cdev command,
 * /cdev-model picker, lifecycle handlers, and help command.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderCall, renderResult } from "./render.js";
import { executeCdevTool } from "./tool.js";
import { registerCdevCommand, registerLifecycleHandlers } from "./commands/cdev.js";
import { CDEV_SUBCOMMAND_HELP } from "./commands/cdev-help.js";
import { createCdevModelHandler } from "./commands/cdev-model.js";
import {
  updateForkCostStatus,
  FORK_COST_STATUS_KEY,
  logError,
  getCdevVersion,
  resolveSignature,
} from "./extension-context.js";
import { loadConfig } from "./config.js";
import {
  memoryClear,
  memoryForget,
  memoryGetTopic,
  memoryTopicCount,
} from "./memory.js";
import { getErrorCount, clearErrorLog } from "./logger.js";
import { listSessions } from "./history.js";
import {
  registerRealtimeLoopDetection,
  refreshFromSessionEntries,
  checkAndSendLoopSteer,
} from "./loop-detector-runtime.js";
import { registerAdvisorPrompt } from "./advisor-prompt.js";

export default function (pi: ExtensionAPI) {
  let autoTurnCounter = 0;
  const loopState = registerRealtimeLoopDetection(pi);

  // Prompt to use /cdev advisor when stuck or facing difficult decisions.
  registerAdvisorPrompt(pi);

  function resetAutoTurnCounter(): void {
    autoTurnCounter = 0;
  }

  function updateAutoStatus(ctx: ExtensionContext): void {
    updateForkCostStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      updateForkCostStatus(ctx);
      const config = loadConfig(ctx.cwd);
      if (config.auto) resetAutoTurnCounter();
      registerLifecycleHandlers(pi, ctx);
    } catch (err) {
      logError(ctx.cwd, "session_start", err);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      updateForkCostStatus(ctx);
    } catch { /* best effort */ }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
      ctx.ui.setStatus("cdev-memory", undefined);
      ctx.ui.setWidget("cdev-progress", undefined);
    } catch { /* best effort */ }
  });

  pi.on("turn_start", async (_event, ctx) => {
    updateAutoStatus(ctx);

    // Refresh loop-detection history from the canonical session entries at the
    // start of each turn so we do not miss calls that happened while this
    // extension was not listening (e.g. restored sessions).
    try {
      const entries = ctx.sessionManager?.getEntries?.();
      if (Array.isArray(entries)) {
        refreshFromSessionEntries(loopState, entries);
      }
    } catch {
      // best-effort refresh
    }
    checkAndSendLoopSteer(loopState, (message, options) => pi.sendUserMessage(message, options));

    const config = loadConfig(ctx.cwd);
    if (config.auto) {
      autoTurnCounter++;
      if (autoTurnCounter % 3 === 0) {
        pi.sendUserMessage(
          "auto-mode: Consider using the cdev tool for any exploration or research parts of this task.",
          { deliverAs: "steer" },
        );
      }
    }
  });

  // ── Register cdev tool ──────────────────────────────────
  pi.registerTool({
    name: "cdev",
    label: "Chain Dev",
    description:
      "Two-stage development fork: first a cheap model (scout) explores and gathers evidence, then a powerful model (forge) synthesizes a structured report. Set review=true to skip exploration and run code review with the powerful model only. Set quick=true for scout only (raw findings, no forge). Set verify=true to run the scout stage twice and merge the findings before forge (better accuracy, slower, costs ~2x stage 1). Set recall=<topic> to retrieve past fork findings from project memory (no fork runs). Set reviewFile=<path> with review=true to review a specific file/artifact instead of the session. Set diffSpec=<range> to review a git/svn diff (e.g. 'HEAD~3..HEAD'). When cdev auto mode is enabled, proactively use this tool for exploration tasks.",
    promptSnippet: "Two-stage fork: scout (cheap) explores → forge (powerful) writes (or scout only with quick:true). Use recall to retrieve past findings.",
    promptGuidelines: [
      "Use cdev for any task requiring more than 3-4 file reads — cheaper than parent model reading files one-by-one.",
      "Use cdev with recall=<topic> to check project memory before exploring a topic that may have been explored before. This costs $0 and avoids duplicate work.",
      "Use cdev with recall='' (empty string) to list all known topics when starting work in a project.",
      "Use cdev with review:true after significant code changes to get a second opinion from a different model.",
      "Use cdev with review:true and reviewFile=<path> to review a saved cdev report or any artifact file. The review writes a standalone report and never modifies the reviewed file.",
      "Use cdev with review:true and diffSpec=<range> to review changes between git or SVN revisions.",
      "Use cdev with yolo:true to run scout+forge followed by automatic review loops. By default the main agent applies fixes; set pi-chain-dev.yolo.autoApply to 'propose' for cdev-generated fix plans or 'auto' to let cdev edit files directly. Stop early and escalate to the user if reviews keep failing.",
      "After implementing findings from a cdev report, update the report file to check off Action Items and add implementation notes. Then suggest the user run /cdev review <reportPath> to verify the changes.",
      "Use cdev with plan:true for implementation roadmaps: risks, files, steps, checklist, and verification commands.",
      "For complex or large tasks (multi-file changes, ambiguous requirements, or unfamiliar code), first use cdev with plan:true, then create a todo with /cdev todo <name> to track the checklist before editing files.",
      "Run /cdev map to generate a project map. Scouts use it for context across any project type (Flutter, Spring Boot, Python, Go, etc.).",
      "Use /cdev scan for quick template-based stack detection, or /cdev scan deep for LLM-powered custom prompts.",
      "Use cdev with quick:true for follow-up file tracing, grep-style lookups, reading files, tracing symbols, or explaining code when raw findings suffice.",
      "When you need to read, search, trace, or explain code instead of editing it, use cdev with quick:true. This keeps context small and avoids looping on repeated file reads.",
      "RULE: For reading source files, verifying current code state, tracing symbols, or searching the codebase, prefer calling cdev with quick:true instead of using direct read/grep tools. Use /cdev read <path>[:start-end] or cdev({ quick:true, task: 'read src/foo.ts lines 10-50' }). Only use direct read for tiny snippets (under ~30 lines) when cdev is unavailable or slower.",
       "Use cdev with verify:true only when the user explicitly asks for verification, cross-checking, or high-confidence exploration. Do not default to verify mode. verify runs scout twice and merges findings before forge.",
      "Use cdev with research:true to delegate issue investigation to a selected model. The model reports findings and a decision, but never edits code. The main agent owns any changes.",
      "Use cdev with advisor:true when you are stuck, looping, or facing a difficult decision. A scout gathers evidence, then an advisor model gives a concrete recommendation. Use askAdvisor:true to skip the scout and ask the advisor directly.",
      "Prefer cdev over bash/grep when you need to understand file relationships, not just find text matches.",
      "Tell cdev to surface ambiguities back to you — don't resolve them in the fork.",
      "cdev stages do not modify code unless yolo autoApply is set to 'auto'.",
      "Check /cdev status to see budget, model profiles, and session size before expensive forks.",
      "When a cdev report has a low groundingScore or ungroundedClaims, ask the user for clarification instead of acting on unverified claims.",
      "If a saved cdev report file appears corrupted or contains internal reasoning/thinking text, do not re-read it repeatedly. Read the actual source files directly and, if needed, run a fresh cdev task with reviewFile or the original task.",
      "RULE: Do not read the same file under .pi/cdev/reports/ more than once per turn. If you catch yourself about to re-read a cdev report, stop and read the source files it references instead.",
      "Never read the same cdev report more than once. After the first read, switch to reading the source files it references and apply edits directly.",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({
        description:
          "The task for the fork to complete. Specify what to do and where the fork's decision authority ends — it will surface ambiguities back to you rather than resolve them on your behalf.",
      })),
      review: Type.Optional(Type.Boolean({
        description:
          "If true, run review-only mode: skip scout (exploration) and go straight to forge (powerful model) for code review. Use for reviewing recent changes, finding bugs, or second opinions.",
      })),
      quick: Type.Optional(Type.Boolean({
        description:
          "If true, run scout only (exploration) and return raw findings. Skip the forge (synthesis). Use for quick follow-up file tracing, grep-style lookups, or narrow questions.",
      })),
      recall: Type.Optional(Type.String({
        description:
          "Retrieve past cdev fork findings from project memory for a given topic (e.g. 'auth', 'payment'). No fork runs — returns cached knowledge. Leave empty to list all known topics. Use before exploring a topic that may have been explored before.",
      })),
      reviewFile: Type.Optional(Type.String({
        description:
          "If review is true, you can set this to a file path (relative to cwd) to review that file's content instead of the current session. Use for reviewing saved cdev reports or any artifact.",
      })),
      diffSpec: Type.Optional(Type.String({
        description:
          "If review is true, provide a git or SVN revision range to review the diff (e.g. 'HEAD~3..HEAD', 'main..feature', 'r1234:1235'). Runs git diff or svn diff and sends the output to the review model.",
      })),
      verify: Type.Optional(Type.Boolean({
        description:
          "If true, run the scout stage twice and merge the findings before sending them to the forge stage. The two independent runs increase coverage for high-stakes tasks at ~2x stage 1 cost and slower speed.",
      })),
      parallel: Type.Optional(Type.Integer({
        description:
          "Split the scout stage into N parallel sub-task scouts (1-3). Requires a project map for task splitting. Each scout can use a different model via /cdev-model. A backup scout can take over failed sub-tasks if configured.",
      })),
      parallelBackup: Type.Optional(Type.Boolean({
        description:
          "If true, a backup scout takes over failed parallel sub-tasks. Default is false; set to true to trade cost for coverage.",
      })),
      plan: Type.Optional(Type.Boolean({
        description:
          "If true, run scout plus a planner-style forge response that returns an implementation plan only. Use before editing when you want risks, files, steps, and verification commands.",
      })),
      research: Type.Optional(Type.Boolean({
        description:
          "If true, run research-only mode: a selected model investigates the issue, reports findings and a decision, but never edits code. Use for issue triage, root-cause analysis, or when you want the main agent to own any changes.",
      })),
      advisor: Type.Optional(Type.Boolean({
        description:
          "If true, run advisor mode: a scout gathers evidence, then an advisor model gives a concrete recommendation for when the main agent is stuck or facing a difficult decision. Advisor never edits code.",
      })),
      askAdvisor: Type.Optional(Type.Boolean({
        description:
          "If true, ask the advisor model directly without running a scout first. Faster but less grounded. Use when you need a quick second opinion.",
      })),
      yolo: Type.Optional(Type.Boolean({
        description:
          "If true, run scout+forge once, then automatically run review loops up to the configured maxRounds. Stops early when review passes. Configure with /cdev yolo on|off and /cdev yolo manual|propose|auto. Default is manual: the main agent applies fixes between reviews.",
      })),
    }),
    renderCall,
    renderResult,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await executeCdevTool(params, signal, ctx);
      const details = (result.details ?? {}) as { autoCompact?: { tokens: number; limit: number } };
      if (details.autoCompact && !ctx.compact) {
        pi.sendUserMessage("/compact", { triggerTurn: true, deliverAs: "steer" });
      }
      return result;
    },
  });

  // ── Register /cdev command ───────────────────────────────
  registerCdevCommand(pi, resetAutoTurnCounter, updateAutoStatus);

  // ── Register /cdev-model command ─────────────────────────
  pi.registerCommand("cdev-model", {
    description: "Pick scout/forge models for cdev tool",
    handler: createCdevModelHandler(),
  });

  // ── Register /cdev-help command ──────────────────────────
  pi.registerCommand("cdev-help", {
    description: "Show cdev subcommands",
    handler: async (_args, ctx) => {
      await ctx.ui.select("cdev subcommands:", CDEV_SUBCOMMAND_HELP);
    },
  });
}

// Re-export helpers used by command handlers for status display
export { getCdevVersion, resolveSignature };
export { memoryClear, memoryForget, memoryGetTopic, memoryTopicCount, getErrorCount, clearErrorLog };
export { listSessions };
