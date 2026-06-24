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

export default function (pi: ExtensionAPI) {
  let autoTurnCounter = 0;

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
    try { updateForkCostStatus(ctx); } catch { /* best effort */ }
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
      "Run /cdev map to generate a project map. Scouts use it for context across any project type (Flutter, Spring Boot, Python, Go, etc.).",
      "Use /cdev scan for quick template-based stack detection, or /cdev scan deep for LLM-powered custom prompts.",
      "Use cdev with quick:true for follow-up file tracing, grep-style lookups, or when raw findings suffice.",
      "Use cdev with verify:true for high-stakes exploration where accuracy matters more than speed or cost. verify runs scout twice and merges findings before forge.",
      "Prefer cdev over bash/grep when you need to understand file relationships, not just find text matches.",
      "Tell cdev to surface ambiguities back to you — don't resolve them in the fork.",
      "cdev stages do not modify code unless yolo autoApply is set to 'auto'.",
      "Check /cdev status to see budget, model profiles, and session size before expensive forks.",
      "When a cdev report has a low groundingScore or ungroundedClaims, ask the user for clarification instead of acting on unverified claims.",
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
          "If true (default), a backup scout takes over failed parallel sub-tasks. Set to false to save cost at the risk of missing coverage.",
      })),
      plan: Type.Optional(Type.Boolean({
        description:
          "If true, run scout plus a planner-style forge response that returns an implementation plan only. Use before editing when you want risks, files, steps, and verification commands.",
      })),
      yolo: Type.Optional(Type.Boolean({
        description:
          "If true, run scout+forge once, then automatically run review loops up to the configured maxRounds. Stops early when review passes. Configure with /cdev yolo on|off and /cdev yolo manual|propose|auto. Default is manual: the main agent applies fixes between reviews.",
      })),
    }),
    renderCall,
    renderResult,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeCdevTool(params, signal, ctx);
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
      await ctx.ui.select("cdev subcommands:", [
        "──────────────────────────────────────",
        "/cdev <task>           Scout + Forge explore",
        "/cdev quick <task>     Scout only (fast)",
        "/cdev verify <task>    Scout ×2 + forge (higher accuracy)",
        "/cdev parallel <n> <task>  Split scout into N parallel scouts (requires map)",
        "/cdev parallel <n> no-backup <task>  Parallel scouts without backup takeover",
        "/cdev plan <task>      Scout + planner (implementation plan only)",
        "/cdev yolo <task>     Scout + forge, then review loops",
        "/cdev yolo manual|propose|auto  Who applies fixes (auto = cdev edits files)",
        "/cdev review [path]    Forge review session/file",
        "/cdev review changes   Review uncommitted changes",
        "/cdev review A..B      Review git/svn diff",
        "/cdev scan [deep]      Generate custom prompts",
        "/cdev map              Generate project map",
        "/cdev map refresh      Regenerate project map via scout+forge",
        "/cdev map show         View project map",
        "/cdev history [n]      Past session details",
        "/cdev recall [topic]   Check project memory",
        "/cdev memory refresh <topic>  Re-explore stale topic",
        "/cdev status           Config overview",
        "/cdev memory on|off    Toggle project memory",
        "/cdev prompts on|off   Toggle custom prompts",
        "/cdev themed on|off    Toggle themed TUI",
        "/cdev auto on|off      Toggle auto-trigger",
        "/cdev yolo on|off      Toggle YOLO review loops",
        "/cdev auto-verify on|off  Toggle automatic verify",
        "/cdev clear            Clear memory + reports",
        "/cdev clear error      Clear error log",
        "/cdev clear reports    Clear old reports",
        "──────────────────────────────────────",
        "/cdev-model            Pick scout/forge models",
        "/cdev-help             This help",
      ]);
    },
  });
}

// Re-export helpers used by command handlers for status display
export { getCdevVersion, resolveSignature };
export { memoryClear, memoryForget, memoryGetTopic, memoryTopicCount, getErrorCount, clearErrorLog };
export { listSessions };
