/**
 * pi-chain-dev Extension
 *
 * Provides tool: cdev({ task: "..." })
 * Provides command: /cdev <task>
 * Provides command: /cdev-model
 *
 * Two-stage fork:
 *   Scout (cheap model): raw exploration findings.
 *   Forge (powerful model): structured report.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_LEVELS, loadConfig, type AutoForkConfig } from "./config.js";
import { runAutoFork, runCdevReview } from "./runner.js";
import { getResultSummaryText, getFinalAssistantText } from "./runner-events.js";
import type { AutoForkDetails, ForkResult, StageProfile } from "./types.js";
import { emptyFailedResult } from "./types.js";
import { scanProject, formatScanReport } from "./scan.js";
import { saveSession, listSessions, getSession, formatHistory, formatSessionRecord, purgeOldSessions } from "./history.js";
import {
  indexFindings,
  loadMemory,
  formatMemoryTopics,
  formatTopicDetail,
  memoryClear,
  memoryForget,
  memoryGetTopic,
  memoryTopicCount,
  getErrorCount,
  clearErrorLog,
} from "./memory.js";

const AutoForkParams = Type.Object({
  task: Type.String({
    description:
      "The task for the fork to complete. Specify what to do and where the fork's decision authority ends — it will surface ambiguities back to you rather than resolve them on your behalf.",
  }),
  review: Type.Optional(Type.Boolean({
    description:
      "If true, run review-only mode: skip scout (exploration) and go straight to forge (powerful model) for code review. Use for reviewing recent changes, finding bugs, or second opinions.",
  })),
  effort: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: [...EFFORT_LEVELS],
    description:
      "Optional reasoning depth. Affects which models are used for the two stages.",
  })),
  quick: Type.Optional(Type.Boolean({
    description:
      "If true, run scout only (exploration) and return raw findings. Skip the forge (synthesis). Use for quick follow-up file tracing, grep-style lookups, or narrow questions.",
  })),
  recall: Type.Optional(Type.String({
    description:
      "Retrieve past cdev fork findings from project memory for a given topic (e.g. 'auth', 'payment'). No fork runs — returns cached knowledge. Leave empty to list all known topics. Use before exploring a topic that may have been explored before.",
  })),
});

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

function buildSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function resolveStageProfiles(
  config: AutoForkConfig,
  requestedEffort?: string,
): { stage1: StageProfile; stage2: StageProfile; warning?: string } {
  // Use configured stage1/stage2 directly
  const stage1 = config.stage1;
  const stage2 = config.stage2;

  if (!stage1.provider || !stage1.id || !stage2.provider || !stage2.id) {
    return {
      stage1: { provider: "", id: "", thinking: "minimal" },
      stage2: { provider: "", id: "", thinking: "xhigh" },
      warning: "cdev is not configured. Add 'pi-chain-dev' to settings.json with stage1 and stage2 profiles.\n\nExample:\n{\n  \"pi-chain-dev\": {\n    \"stage1\": { \"provider\": \"openai-codex\", \"id\": \"gpt-5-mini\", \"thinking\": \"minimal\" },\n    \"stage2\": { \"provider\": \"opencode-go\", \"id\": \"deepseek-v4-flash\", \"thinking\": \"xhigh\" }\n  }\n}",
    };
  }

  return { stage1, stage2 };
}

function formatResultContent(result: ForkResult, details: AutoForkDetails): string {
  const finalText = getFinalAssistantText(result.messages);

  if (result.errorMessage && !finalText) {
    const stageInfo = details.stage1
      ? ` | Stage 1: ${details.stage1.model || "?"} (exit ${details.stage1.exitCode})`
      : "";
    const stage2Info = details.stage2
      ? ` | Stage 2: ${details.stage2.model || "?"} (exit ${details.stage2.exitCode})`
      : "";
    return `cdev failed: ${result.errorMessage}${stageInfo}${stage2Info}`;
  }

  const summary = finalText || getResultSummaryText(result);

  // Prepend stage info
  let header = "";
  const isReview = details.stage1 === null && details.stage2 !== null;
  if (isReview) {
    header += `Review ran with ${details.stage2?.model || "?"}: ${details.stage2?.exitCode ?? "?"} exit\n\n`;
  } else {
    if (details.stage1) {
      header += `Stage 1 (exploration) ran with ${details.stage1.model || "?"}: ${details.stage1.exitCode} exit\n`;
    }
    if (details.stage2) {
      header += `Stage 2 (synthesis) ran with ${details.stage2.model || "?"}: ${details.stage2.exitCode} exit\n`;
    }
    if (header) header += "\n";
  }

  return header + summary;
}

export default function (pi: ExtensionAPI) {
  // ── Footer cost status ──────────────────────────────────
  const FORK_COST_STATUS_KEY = "cdev-cost";

  /** Package developer signature. Override with config.signature. */
  function getSignature(_cwd: string): string {
    return "whatley.xyz";
  }

  /** Append an error record to .pi/cdev/errors.jsonl */
  function logError(cwd: string, context: string, err: unknown): void {
    try {
      const cdevDir = join(cwd, ".pi", "cdev");
      mkdirSync(cdevDir, { recursive: true });
      const record = JSON.stringify({
        ts: new Date().toISOString(),
        context,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      appendFileSync(join(cdevDir, "errors.jsonl"), record + "\n", "utf-8");
    } catch {
      // fail silently — can't log the log error
    }
  }

  function updateForkCostStatus(ctx: ExtensionContext): void {
    const config = loadConfig(ctx.cwd);
    if (!config.costFooter) {
      ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
      return;
    }

    // Aggregate cost from cdev tool results
    const entries = ctx.sessionManager.getEntries();
    let totalCost = 0;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message") {
        const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined;
        if (message?.role === "toolResult" && message?.toolName === "cdev") {
          const details = message.details as AutoForkDetails | undefined;
          if (details?.stage1?.usage?.cost) totalCost += details.stage1.usage.cost;
          if (details?.stage2?.usage?.cost) totalCost += details.stage2.usage.cost;
        }
      }
    }

    const parts: string[] = [];
    if (config.auto) parts.push("⚡");
    parts.push("cdev");
    if (config.prompts?.explore || config.prompts?.review) {
      parts.push(config.promptsEnabled ? "📋" : "📋✕");
    }
    if (totalCost > 0) parts.push(`+$${totalCost.toFixed(4)}`);

    const status = parts.length > 1
      ? ctx.ui.theme.fg("dim", parts.join("  "))
      : undefined;
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, status);
  }

  pi.on("session_start", async (_event, ctx) => updateForkCostStatus(ctx));
  pi.on("turn_end", async (_event, ctx) => updateForkCostStatus(ctx));
  // Inject project memory status on session start
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.memory) {
      const topicCount = memoryTopicCount(ctx.cwd);
      if (topicCount > 0) {
        ctx.ui.setStatus("cdev-memory", `🧠 ${topicCount} topic${topicCount > 1 ? "s" : ""}  /cdev recall`);
      }
    } else {
      ctx.ui.setStatus("cdev-memory", undefined);
    }
    const purged = purgeOldSessions(ctx.cwd, 7);
    if (purged > 0) {
      ctx.ui.notify(`Purged ${purged} old cdev session${purged > 1 ? "s" : ""} (>7 days)`, "info");
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
    ctx.ui.setStatus("cdev-memory", undefined);
  });

  // ── Combined cdev status ──────────────────────────────
  // Shows: ⚡ auto indicator, 📋 prompts indicator, +$cost
  // All managed by updateForkCostStatus above.

  function updateAutoStatus(ctx: ExtensionContext): void {
    updateForkCostStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => updateAutoStatus(ctx));
  // Auto-trigger counter: inject steer every 3 turns when enabled
  let autoTurnCounter = 0;
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

  function updatePromptsStatus(ctx: ExtensionContext): void {
    updateForkCostStatus(ctx);
  }

  // ── Register cdev tool ──────────────────────────────────
  pi.registerTool({
    name: "cdev",
    label: "Chain Dev",
    description:
      "Two-stage development fork: first a cheap model (scout) explores and gathers evidence, then a powerful model (forge) synthesizes a structured report. Set review=true to skip exploration and run code review with the powerful model only. Set quick=true for scout only (raw findings, no forge). Set recall=<topic> to retrieve past fork findings from project memory (no fork runs). When cdev auto mode is enabled, proactively use this tool for exploration tasks.",
    promptSnippet: "Two-stage fork: scout (cheap) explores → forge (powerful) writes (or scout only with quick:true). Use recall to retrieve past findings.",
    promptGuidelines: [
      "Use cdev for any task requiring more than 3-4 file reads — cheaper than parent model reading files one-by-one.",
      "Use cdev with recall=<topic> to check project memory before exploring a topic that may have been explored before. This costs $0 and avoids duplicate work.",
      "Use cdev with recall='' (empty string) to list all known topics when starting work in a project.",
      "Use cdev with review:true after significant code changes to get a second opinion from a different model.",
      "Use cdev with quick:true for follow-up file tracing, grep-style lookups, or when raw findings suffice.",
      "Prefer cdev over bash/grep when you need to understand file relationships, not just find text matches.",
      "Tell cdev to surface ambiguities back to you — don't resolve them in the fork.",
    ],
    parameters: AutoForkParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
      const config = loadConfig(ctx.cwd);

      // ── Recall mode (no fork, just memory lookup) ──
      if (params.recall !== undefined) {
        if (!config.memory) {
          return {
            content: [{ type: "text" as const, text: "cdev memory is disabled. Enable with /cdev memory on." }],
            details: { stage1: null, stage2: null },
          };
        }
        if (params.recall) {
          const entry = memoryGetTopic(ctx.cwd, params.recall);
          if (entry) {
            const detail = formatTopicDetail(entry, ctx.cwd);
            return {
              content: [{ type: "text" as const, text: `🧠 cdev memory hit: ${params.recall}\n\n${detail}` }],
              details: { stage1: null, stage2: null },
            };
          }
          return {
            content: [{ type: "text" as const, text: `🧠 cdev memory miss: no findings for "${params.recall}".` }],
            details: { stage1: null, stage2: null },
          };
        }
        // Empty string = list all topics
        const memory = loadMemory(ctx.cwd);
        const listing = formatMemoryTopics(memory);
        return {
          content: [{ type: "text" as const, text: `🧠 cdev memory\n\n${listing}` }],
          details: { stage1: null, stage2: null },
        };
      }

      // ── Review mode ──
      if (params.review) {
        if (!config.stage2.provider || !config.stage2.id) {
          return {
            content: [{ type: "text" as const, text: "cdev review error: Stage 2 model not configured. Use /cdev-model." }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
        if (!snapshot) {
          return {
            content: [{ type: "text" as const, text: "cdev review error: Cannot snapshot session." }],
            details: { stage1: null, stage2: null },
            isError: true,
          };
        }
        const startTime = Date.now();
        const { result, details } = await runCdevReview({
          cwd: ctx.cwd,
          forkSessionSnapshotJsonl: snapshot,
          stageProfile: config.stage2,
          customReviewPrompt: config.promptsEnabled ? config.prompts?.review : undefined,
          extensions: config.extensions,
          environment: config.environment,
          offline: config.offline,
          signal,
        });
        saveSession(ctx.cwd, params.task, true, startTime, details, result);
        if (result.errorMessage) {
          logError(ctx.cwd, "review-stage2", new Error(result.errorMessage));
        }
        if (config.memory) {
          indexFindings({
            task: params.task,
            resultText: getFinalAssistantText(result.messages) || "",
            stage2Model: config.stage2.id,
            isReview: true,
            quick: false,
            cost: (result.usage?.cost ?? 0),
            cwd: ctx.cwd,
          });
        }
        const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);
        return {
          content: [{ type: "text" as const, text: formatResultContent(result, details) }],
          details,
          isError,
        };
      }

      // ── Full two-stage mode ──
      const profiles = resolveStageProfiles(config, params.effort);

      if (profiles.warning) {
        const result = emptyFailedResult(params.task, profiles.warning);
        return {
          content: [{ type: "text" as const, text: `cdev error: ${profiles.warning}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
      if (!snapshot) {
        const result = emptyFailedResult(
          params.task,
          "Cannot cdev: failed to snapshot current session context.",
        );
        return {
          content: [{ type: "text" as const, text: `cdev error: ${result.errorMessage}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }

      const startTime = Date.now();
      const { result, details } = await runAutoFork({
        cwd: ctx.cwd,
        task: params.task,
        forkSessionSnapshotJsonl: snapshot,
        stage1Profile: profiles.stage1,
        stage2Profile: profiles.stage2,
        customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
        customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
        quick: params.quick ?? false,
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal,
      });

      saveSession(ctx.cwd, params.task, false, startTime, details, result);
      if (result.errorMessage) {
        logError(ctx.cwd, "full-mode", new Error(result.errorMessage));
      }
      if (config.memory) {
        indexFindings({
          task: params.task,
          resultText: getFinalAssistantText(result.messages) || "",
          stage1Model: config.stage1.id,
          stage2Model: params.quick ? undefined : config.stage2.id,
          isReview: false,
          quick: params.quick ?? false,
          cost: (result.usage?.cost ?? 0),
          cwd: ctx.cwd,
        });
      }

      const isError = result.exitCode > 0 && !getFinalAssistantText(result.messages);

      return {
        content: [{ type: "text" as const, text: formatResultContent(result, details) }],
        details,
        isError,
      };
      } catch (err) {
        logError(ctx.cwd, "tool", err);
        return {
          content: [{ type: "text" as const, text: `cdev error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { stage1: null, stage2: null },
          isError: true,
        };
      }
    },
  });

  // ── Register /cdev command ───────────────────────────────
  pi.registerCommand("cdev", {
    description: "Two-stage chain dev. Subcommands: auto on|off, review, <task>",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      // ── Subcommand: auto on ──
      if (trimmed === "auto on" || trimmed === "auto") {
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).auto = true;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify("cdev auto mode ON — LLM will proactively use cdev for exploration", "info");
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: auto off ──
      if (trimmed === "auto off") {
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).auto = false;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify("cdev auto mode OFF", "info");
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: scan deep ──
      if (trimmed === "scan deep") {
        const config = loadConfig(ctx.cwd);
        const profiles = resolveStageProfiles(config);
        if (profiles.warning) {
          ctx.ui.notify(profiles.warning, "warn");
          return;
        }
        ctx.ui.notify("Deep scanning project (stage 1 → stage 2)...", "info");
        try {
          const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
          if (!snapshot) { ctx.ui.notify("Cannot snapshot session.", "error"); return; }

          const task = `Scan this project's architecture, conventions, and patterns. Generate 3 focused prompts for future cdev use:
1. explore — what to focus on during exploration (stack-specific patterns, conventions, key areas)
2. synthesize — how to structure synthesis reports (what risks to flag, what ordering matters)
3. review — what to check during code review (project-specific pitfalls, conventions, anti-patterns)

Read package.json, key source files, config files, and directory structure. Return ONLY the 3 prompts in this format:

EXPLORE_PROMPT:
<text>

SYNTHESIZE_PROMPT:
<text>

REVIEW_PROMPT:
<text>`;

          const scanStartTime = Date.now();
          const { result, details } = await runAutoFork({
            cwd: ctx.cwd,
            task,
            forkSessionSnapshotJsonl: snapshot,
            stage1Profile: profiles.stage1,
            stage2Profile: profiles.stage2,
            extensions: config.extensions,
            environment: config.environment,
            offline: config.offline,
            signal: undefined,
          });

          saveSession(ctx.cwd, task, false, scanStartTime, details, result);
          if (result.errorMessage) {
            logError(ctx.cwd, "deep-scan-fork", new Error(result.errorMessage));
          }
          if (config.memory) {
            indexFindings({
              task,
              resultText: getFinalAssistantText(result.messages) || "",
              stage1Model: profiles.stage1.id,
              stage2Model: profiles.stage2.id,
              isReview: false,
              quick: false,
              cost: (result.usage?.cost ?? 0),
              cwd: ctx.cwd,
            });
          }

          // Parse prompts from result
          const text = getFinalAssistantText(result.messages) || "";
          const exploreMatch = text.match(/EXPLORE_PROMPT:\s*\n([\s\S]*?)(?=\n\nSYNTHESIZE_PROMPT:|$)/i);
          const synthMatch = text.match(/SYNTHESIZE_PROMPT:\s*\n([\s\S]*?)(?=\n\nREVIEW_PROMPT:|$)/i);
          const reviewMatch = text.match(/REVIEW_PROMPT:\s*\n([\s\S]*?)$/i);

          const explore = exploreMatch?.[1]?.trim() || "";
          const synthesize = synthMatch?.[1]?.trim() || "";
          const review = reviewMatch?.[1]?.trim() || "";

          if (!explore && !review) {
            ctx.ui.notify("Could not parse prompts from model output. Falling back to template scan.", "warn");
            return; // user can run /cdev scan for template
          }

          // Save to project .pi/settings.json
          const projectDir = join(ctx.cwd, ".pi");
          if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });
          const projectSettingsPath = join(projectDir, "settings.json");
          let projSettings: Record<string, unknown> = {};
          if (existsSync(projectSettingsPath)) {
            projSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
          }
          if (!projSettings["pi-chain-dev"]) projSettings["pi-chain-dev"] = {};
          (projSettings["pi-chain-dev"] as Record<string, unknown>).prompts = { explore, synthesize, review };
          (projSettings["pi-chain-dev"] as Record<string, unknown>).promptsEnabled = true;
          writeFileSync(projectSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");

          ctx.ui.notify(
            `Deep scan complete!\nStage 1: ${details.stage1?.model || "?"}\nStage 2: ${details.stage2?.model || "?"}\n\nPrompts saved to .pi/settings.json\nToggle: /cdev prompts on|off`,
            "info"
          );
          updatePromptsStatus(ctx);
        } catch (err) {
          logError(ctx.cwd, "deep-scan", err);
          ctx.ui.notify(`Deep scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // ── Subcommand: scan ──
      if (trimmed === "scan") {
        ctx.ui.notify("Scanning project for stack detection...", "info");
        try {
          const result = scanProject(ctx.cwd);
          const report = formatScanReport(result);

          // Save prompts to PROJECT's .pi/settings.json
          const projectDir = join(ctx.cwd, ".pi");
          if (!existsSync(projectDir)) {
            mkdirSync(projectDir, { recursive: true });
          }
          const projectSettingsPath = join(projectDir, "settings.json");
          let projSettings: Record<string, unknown> = {};
          if (existsSync(projectSettingsPath)) {
            projSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
          }
          if (!projSettings["pi-chain-dev"]) projSettings["pi-chain-dev"] = {};
          (projSettings["pi-chain-dev"] as Record<string, unknown>).prompts = result.prompts;
          (projSettings["pi-chain-dev"] as Record<string, unknown>).promptsEnabled = true;
          writeFileSync(projectSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");

          ctx.ui.notify(report, "info");
          updatePromptsStatus(ctx);
        } catch (err) {
          logError(ctx.cwd, "template-scan", err);
          ctx.ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // ── Subcommand: recall ──
      const recallMatch = trimmed.match(/^recall(?:\s+(.+))?$/);
      if (recallMatch) {
        const config = loadConfig(ctx.cwd);
        if (!config.memory) {
          ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
          return;
        }
        const topic = recallMatch[1]?.trim();
        if (topic) {
          const entry = memoryGetTopic(ctx.cwd, topic);
          if (entry) {
            ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
          } else {
            ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
          }
        } else {
          const memory = loadMemory(ctx.cwd);
          ctx.ui.notify(formatMemoryTopics(memory), "info");
        }
        return;
      }

      // ── Subcommand: view (alias for recall) ──
      const viewMatch = trimmed.match(/^view(?:\s+(.+))?$/);
      if (viewMatch) {
        const topic = viewMatch[1]?.trim();
        if (topic) {
          const entry = memoryGetTopic(ctx.cwd, topic);
          if (entry) {
            ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
          } else {
            ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
          }
        } else {
          const memory = loadMemory(ctx.cwd);
          ctx.ui.notify(formatMemoryTopics(memory), "info");
        }
        return;
      }

      // ── Subcommand: clear ──
      if (trimmed === "clear") {
        memoryClear(ctx.cwd);
        ctx.ui.notify("Cleared all cdev project memory.", "info");
        return;
      }

      // ── Subcommand: memory clear ──
      if (trimmed === "memory clear") {
        memoryClear(ctx.cwd);
        ctx.ui.notify("Cleared all cdev project memory.", "info");
        return;
      }

      // ── Subcommand: clear error ──
      if (trimmed === "clear error") {
        const count = getErrorCount(ctx.cwd);
        clearErrorLog(ctx.cwd);
        ctx.ui.notify(`Cleared ${count} error${count !== 1 ? "s" : ""} from cdev error log.`, "info");
        return;
      }

      // ── Subcommand: memory forget <topic> ──
      const memoryForgetMatch = trimmed.match(/^memory forget\s+(.+)$/);
      if (memoryForgetMatch) {
        const topic = memoryForgetMatch[1].trim();
        const removed = memoryForget(ctx.cwd, topic);
        if (removed) {
          ctx.ui.notify(`Removed memory for topic "${topic}".`, "info");
        } else {
          ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
        }
        return;
      }

      // ── Subcommand: memory on/off ──
      if (trimmed === "memory on" || trimmed === "memory off") {
        const enable = trimmed === "memory on";
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).memory = enable;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify(`Project memory ${enable ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Subcommand: prompts on/off ──
      if (trimmed === "prompts on" || trimmed === "prompts off") {
        const enable = trimmed === "prompts on";
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).promptsEnabled = enable;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        ctx.ui.notify(`Custom prompts ${enable ? "ON" : "OFF"}`, "info");
        updatePromptsStatus(ctx);
        return;
      }

      // ── Subcommand: history ──
      const historyMatch = trimmed.match(/^history(?:\s+(\d+))?$/);
      if (historyMatch) {
        const sessionNum = historyMatch[1] ? parseInt(historyMatch[1], 10) : undefined;
        if (sessionNum !== undefined) {
          const session = getSession(ctx.cwd, sessionNum);
          if (session) {
            ctx.ui.notify(formatSessionRecord(session), "info");
          } else {
            ctx.ui.notify(`No session #${sessionNum}. Try /cdev history to list.`, "warn");
          }
        } else {
          const sessions = listSessions(ctx.cwd);
          ctx.ui.notify(formatHistory(sessions), "info");
        }
        return;
      }

      // ── Subcommand: review ──
      if (trimmed === "review") {
        const config = loadConfig(ctx.cwd);
        if (!config.stage2.provider || !config.stage2.id) {
          ctx.ui.notify("Stage 2 model not configured. Use /cdev-model to set models.", "warn");
          return;
        }
        ctx.ui.notify("Queuing code review (stage 2 only)...", "info");
        pi.sendUserMessage("Run a code review using the cdev tool with review=true. Review the recent changes in this session for bugs, edge cases, and improvements.", {
          triggerTurn: true,
          deliverAs: "steer",
        });
        return;
      }

      // ── Subcommand: quick ──
      if (trimmed.startsWith("quick ")) {
        const quickTask = trimmed.slice(6).trim();
        if (!quickTask) {
          ctx.ui.notify("Usage: /cdev quick <task>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing quick exploration (stage 1 only)...`, "info");
        pi.sendUserMessage(`Use cdev with quick=true to: ${quickTask}`, {
          triggerTurn: true,
          deliverAs: "steer",
        });
        return;
      }

      // ── Subcommand: status ──
      if (trimmed === "status" || trimmed === "info") {
        const config = loadConfig(ctx.cwd);
        const lines: string[] = [
          "── cdev status ─────────────────────────────────────",
          "",
          `  👤 ${config.signature || getSignature(ctx.cwd)}`,
          "",
          `  Current model:    ${ctx.model ? ctx.model.id : "none"}`,
          `  Scout:  ${config.stage1.provider}:${config.stage1.id}  •  ${config.stage1.thinking}`,
          `  Forge:  ${config.stage2.provider}:${config.stage2.id}  •  ${config.stage2.thinking}`,
          `  Auto-trigger:     ${config.auto ? "⚡ ON" : "OFF"}`,
          `  Custom prompts:   ${config.prompts?.explore || config.prompts?.review ? (config.promptsEnabled ? "📋 ON (custom)" : "📋✕ OFF (custom exists)") : "— (none)"}`,
          `  Cost footer:      ${config.costFooter ? "ON" : "OFF"}`,
          `  Project memory:   ${config.memory ? "ON" : "OFF"}`,
          `  Offline mode:     ${config.offline ? "ON" : "OFF"}`,
          `  Extensions:       ${config.extensions === null ? "inherit" : config.extensions.length === 0 ? "none" : config.extensions.join(", ")}`,
          "",
        ];
        const sessions = listSessions(ctx.cwd);
        if (sessions.length > 0) {
          let totalCost = 0;
          for (const s of sessions) totalCost += (s.stage1?.cost ?? 0) + (s.stage2?.cost ?? 0);
          lines.push(`  Sessions:         ${sessions.length} (7-day window, $${totalCost.toFixed(4)} total)`);
        }
        const topicCount = memoryTopicCount(ctx.cwd);
        if (topicCount > 0 && config.memory) {
          lines.push(`  Project memory:   ${topicCount} topic${topicCount > 1 ? "s" : ""}  /cdev recall`);
        }
        const errorCount = getErrorCount(ctx.cwd);
        if (errorCount > 0) {
          lines.push(`  Error log:        ${errorCount} error${errorCount > 1 ? "s" : ""}  /cdev clear error to wipe`);
        }
        lines.push("");
        lines.push("─────────────────────────────────────────────────────");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── Default: task mode ──
      if (!trimmed) {
        ctx.ui.notify("Usage: /cdev <task>  |  /cdev quick <task>  |  /cdev review  |  /cdev scan [deep]  |  /cdev history [n]  |  /cdev recall [topic]  |  /cdev [memory] clear  |  /cdev memory forget <topic>  |  /cdev status  |  /cdev auto|prompts [on|off]", "warn");
        return;
      }
      ctx.ui.notify("Queuing cdev task...", "info");
      pi.sendUserMessage(`Use cdev to: ${trimmed}`, {
        triggerTurn: true,
        deliverAs: "steer",
      });
    },
  });

  // ── Register /cdev-model command ─────────────────────────
  pi.registerCommand("cdev-model", {
    description: "Pick scout/forge models for cdev tool",
    handler: async (_args, ctx) => {
      try {
      const config = loadConfig(ctx.cwd);

      // Step 1: pick stage
      const stagePick = await ctx.ui.select("Pick model:", [
        `Scout (explore)  [${config.stage1.provider || "?"}/${config.stage1.id || "?"}]`,
        `Forge (synthesize)  [${config.stage2.provider || "?"}/${config.stage2.id || "?"}]`,
      ]);
      if (!stagePick) return;
      const stage = stagePick.startsWith("stage1") ? "stage1" : "stage2";

      // Step 2: show all models via select (max 50)
      const allModels = ctx.modelRegistry.getAvailable();
      const modelItems = allModels.slice(0, 50).map(m =>
        `${m.id} [${m.provider}]`
      );
      const modelPick = await ctx.ui.select(
        `Pick ${stage} model (arrow keys to scroll):`,
        modelItems
      );
      if (!modelPick) return;
      
      // Parse "modelId [provider]"
      const match = modelPick.match(/^(.+?)\s+\[(.+?)\]/);
      if (!match) { ctx.ui.notify("Parse error: " + modelPick, "error"); return; }
      const modelId = match[1].trim();
      const provider = match[2].trim();

      // Step 3: pick thinking
      const thinkingPick = await ctx.ui.select("Pick thinking level:", [
        "off", "minimal", "low", "medium", "high", "xhigh",
      ]);
      if (!thinkingPick) return;

      // Save
      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
      if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
      (settings["pi-chain-dev"] as Record<string, unknown>)[stage] = {
        provider, id: modelId, thinking: thinkingPick,
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`Set ${stage} to ${provider}/${modelId} (${thinkingPick}). /reload to apply.`, "info");
      } catch (err) {
        logError(ctx.cwd, "cdev-model", err);
        ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
