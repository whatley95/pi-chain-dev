import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { runAutoFork } from "../runner.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession, listSessions, getSession, formatHistory, formatSessionRecord, purgeOldSessions } from "../history.js";
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
  getErrorCount,
  clearErrorLog,
} from "../memory.js";
import { scanProject, formatScanReport } from "../scan.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  getCdevVersion,
  resolveSignature,
  logError,
} from "../extension-context.js";

export function registerCdevCommand(
  pi: ExtensionAPI,
  resetAutoTurnCounter: () => void,
  updateAutoStatus: (ctx: ExtensionContext) => void,
  updatePromptsStatus: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand("cdev", {
    description: "Two-stage chain dev. Subcommands: auto on|off, review [path], quick <task>, verify <task>, status, prompts on|off, history, scan [deep], recall [topic], memory refresh <topic>, memory on|off, themed on|off",
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
        resetAutoTurnCounter();
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
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: scan deep ──
      if (trimmed === "scan deep") {
        const config = loadConfig(ctx.cwd);
        const profiles = resolveStageProfiles(config);
        const themedBg = makeThemedBg(ctx, config.themed);
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

          const scanTask = withAuditGuard(task);
          const scanStartTime = Date.now();
          const onProgress = (stage: string, model: string) => {
            if (stage === "scout") {
              ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔍 Scout exploring…  (${model})`)]);
            } else {
              ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge synthesizing…  (${model})`)]);
            }
          };
          onProgress("scout", profiles.stage1.id);
          const { result, details: scanDetails } = await runAutoFork({
            cwd: ctx.cwd,
            task: scanTask,
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

          saveSession(ctx.cwd, task, false, scanStartTime, scanDetails, result);
          if (result.errorMessage) logError(ctx.cwd, "deep-scan-fork", new Error(result.errorMessage));
          if (config.memory) {
            indexFindingsAsync({
              task,
              resultText: getFinalAssistantText(result.messages) || "",
              stage1Model: scanDetails.stage1?.model ?? profiles.stage1.id,
              stage2Model: scanDetails.stage2?.model ?? profiles.stage2.id,
              isReview: false,
              quick: false,
              cost: result.usage?.cost ?? 0,
              cwd: ctx.cwd,
            });
          }

          const text = getFinalAssistantText(result.messages) || "";
          const exploreMatch = text.match(/EXPLORE_PROMPT:\s*\n([\s\S]*?)(?=\n\nSYNTHESIZE_PROMPT:|$)/i);
          const synthMatch = text.match(/SYNTHESIZE_PROMPT:\s*\n([\s\S]*?)(?=\n\nREVIEW_PROMPT:|$)/i);
          const reviewMatch = text.match(/REVIEW_PROMPT:\s*\n([\s\S]*?)$/i);

          const explore = exploreMatch?.[1]?.trim() || "";
          const synthesize = synthMatch?.[1]?.trim() || "";
          const review = reviewMatch?.[1]?.trim() || "";

          if (!explore && !review) {
            ctx.ui.notify("Could not parse prompts from model output. Falling back to template scan.", "warn");
            return;
          }

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
            `Deep scan complete!\nScout: ${scanDetails.stage1?.model || "?"}\nForge: ${scanDetails.stage2?.model || "?"}\n\nPrompts saved to .pi/settings.json\nToggle: /cdev prompts on|off`,
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

          const projectDir = join(ctx.cwd, ".pi");
          if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });
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
          if (entry) ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
          else ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
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
          if (entry) ctx.ui.notify(formatTopicDetail(entry, ctx.cwd), "info");
          else ctx.ui.notify(`No memory for topic "${topic}". /cdev recall to list all.`, "warn");
        } else {
          const memory = loadMemory(ctx.cwd);
          ctx.ui.notify(formatMemoryTopics(memory), "info");
        }
        return;
      }

      // ── Subcommand: clear ──
      if (trimmed === "clear") {
        memoryClear(ctx.cwd);
        let cleared = 0;
        const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
        if (existsSync(reportsDir)) {
          for (const entry of readdirSync(reportsDir)) {
            if (entry.endsWith(".md")) {
              unlinkSync(join(reportsDir, entry));
              cleared++;
            }
          }
        }
        ctx.ui.notify(`Cleared cdev project memory${cleared > 0 ? ` + ${cleared} report${cleared !== 1 ? "s" : ""}` : ""}.`, "info");
        return;
      }

      // ── Subcommand: clear reports ──
      if (trimmed === "clear reports") {
        const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
        let cleared = 0;
        if (existsSync(reportsDir)) {
          for (const entry of readdirSync(reportsDir)) {
            if (entry.endsWith(".md")) {
              unlinkSync(join(reportsDir, entry));
              cleared++;
            }
          }
        }
        ctx.ui.notify(`Cleared ${cleared} cdev report${cleared !== 1 ? "s" : ""}.`, "info");
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
        if (removed) ctx.ui.notify(`Removed memory for topic "${topic}".`, "info");
        else ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
        return;
      }

      // ── Subcommand: memory merge ──
      if (trimmed === "memory merge") {
        const merged = mergeSimilarTopics(ctx.cwd);
        if (merged.length > 0) {
          ctx.ui.notify(`Merged similar topics:\n${merged.join("\n")}`, "info");
        } else {
          ctx.ui.notify("No similar topics to merge.", "info");
        }
        return;
      }

      // ── Subcommand: memory refresh <topic> ──
      const memoryRefreshMatch = trimmed.match(/^memory refresh\s+(.+)$/);
      if (memoryRefreshMatch) {
        const config = loadConfig(ctx.cwd);
        if (!config.memory) {
          ctx.ui.notify("Project memory is disabled. /cdev memory on to enable.", "warn");
          return;
        }
        const profiles = resolveStageProfiles(config);
        if (profiles.warning) {
          ctx.ui.notify(profiles.warning, "warn");
          return;
        }
        const topic = memoryRefreshMatch[1].trim();
        const entry = memoryGetTopic(ctx.cwd, topic);
        if (!entry) {
          ctx.ui.notify(`No memory found for topic "${topic}".`, "warn");
          return;
        }

        ctx.ui.notify(`Refreshing memory topic "${topic}" (stage 1 → stage 2)...`, "info");
        try {
          const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
          if (!snapshot) { ctx.ui.notify("Cannot snapshot session.", "error"); return; }

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

      // ── Subcommand: themed on/off ──
      if (trimmed === "themed on" || trimmed === "themed off") {
        const enable = trimmed === "themed on";
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
        (settings["pi-chain-dev"] as Record<string, unknown>).themed = enable;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

        const projSettingsPath = join(ctx.cwd, ".pi", "settings.json");
        if (existsSync(projSettingsPath)) {
          const projSettings = JSON.parse(readFileSync(projSettingsPath, "utf-8"));
          const projCdev = projSettings?.["pi-chain-dev"] as Record<string, unknown> | undefined;
          if (projCdev && "themed" in projCdev) {
            projCdev.themed = enable;
            writeFileSync(projSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");
          }
        }

        ctx.ui.notify(`Themed TUI rendering ${enable ? "ON" : "OFF"}`, "info");
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
          if (session) ctx.ui.notify(formatSessionRecord(session), "info");
          else ctx.ui.notify(`No session #${sessionNum}. Try /cdev history to list.`, "warn");
        } else {
          const sessions = listSessions(ctx.cwd);
          ctx.ui.notify(formatHistory(sessions), "info");
        }
        return;
      }

      // ── Subcommand: review [path|diff] ──
      const reviewFileMatch = trimmed.match(/^review\s+(.+)$/);
      if (trimmed === "review" || reviewFileMatch) {
        let cleanArg = "";
        if (reviewFileMatch) {
          cleanArg = reviewFileMatch[1].trim();
          if (cleanArg === "--audit" || cleanArg === "-a") {
            ctx.ui.notify(`Queuing code review…`, "info");
            pi.sendUserMessage(`Run a code review using the cdev tool with review=true.`, { triggerTurn: true, deliverAs: "steer" });
            return;
          }
          cleanArg = cleanArg.replace(/\s*(--audit|-a)\b/gi, "").trim();
        }
        const config = loadConfig(ctx.cwd);
        const reviewProfile = config.review ?? config.stage2;
        if (!reviewProfile.provider || !reviewProfile.id) {
          ctx.ui.notify("Review model not configured. Use /cdev-model to set models.", "warn");
          return;
        }
        if (cleanArg) {
          const isDiff = cleanArg.includes("..") || /^r\d+[:\-]\d+$/.test(cleanArg);
          const looksLikePath = /[\\\/]/.test(cleanArg) || /\.[a-z]{2,6}$/i.test(cleanArg);
          if (isDiff) {
            ctx.ui.notify(`Reviewing diff ${cleanArg}…`, "info");
            pi.sendUserMessage(`Review the diff ${cleanArg} using cdev with review=true, diffSpec="${cleanArg}".`, { triggerTurn: true, deliverAs: "steer" });
          } else if (looksLikePath) {
            const fullPath = isAbsolute(cleanArg) ? cleanArg : join(ctx.cwd, cleanArg);
            if (!existsSync(fullPath)) {
              ctx.ui.notify(`File not found: ${fullPath}`, "error");
              return;
            }
            ctx.ui.notify(`Reviewing ${cleanArg}…`, "info");
            pi.sendUserMessage(`Review the file ${cleanArg} using cdev with review=true, reviewFile="${cleanArg}".`, { triggerTurn: true, deliverAs: "steer" });
          } else {
            ctx.ui.notify(`Queuing code review…`, "info");
            pi.sendUserMessage(`Run a code review using the cdev tool with review=true. Focus on: ${cleanArg}`, { triggerTurn: true, deliverAs: "steer" });
          }
        } else {
          ctx.ui.notify(`Queuing code review (forge only)…`, "info");
          pi.sendUserMessage(`Run a code review using the cdev tool with review=true. Review the recent changes in this session for bugs, edge cases, and improvements.`, { triggerTurn: true, deliverAs: "steer" });
        }
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
        pi.sendUserMessage(`Use cdev with quick=true to: ${quickTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: verify ──
      if (trimmed.startsWith("verify ")) {
        const verifyTask = trimmed.slice(7).trim();
        if (!verifyTask) {
          ctx.ui.notify("Usage: /cdev verify <task>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing verified exploration (scout ×2 + forge)...`, "info");
        pi.sendUserMessage(`Use cdev with verify=true to: ${verifyTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: status ──
      if (trimmed === "status" || trimmed === "info") {
        const config = loadConfig(ctx.cwd);
        const lines: string[] = [
          "── cdev status ─────────────────────────────────────",
          "",
          `  👤 ${resolveSignature(config)}`,
          `  Version:          ${getCdevVersion(ctx.cwd)}`,
          "",
          `  Current model:    ${ctx.model ? ctx.model.id : "none"}`,
          `  Scout:  ${config.stage1.provider}:${config.stage1.id}  •  ${config.stage1.thinking}`,
          `  Forge:  ${config.stage2.provider}:${config.stage2.id}  •  ${config.stage2.thinking}`,
          `  Review: ${config.review ? `${config.review.provider}:${config.review.id}  •  ${config.review.thinking}` : `↳ Forge (${config.stage2.id})`}`,
          `  Auto-trigger:     ${config.auto ? "⚡ ON (sends steer every 3 turns to prompt cdev use)" : "OFF (agent uses cdev only when asked or it decides)"}`,
          `  Custom prompts:   ${config.prompts?.explore || config.prompts?.review ? (config.promptsEnabled ? "📋 ON (custom)" : "📋✕ OFF (custom exists)") : "— (none)"}`,
          `  Cost footer:      ${config.costFooter ? "ON" : "OFF"}`,
          `  Project memory:   ${config.memory ? "ON" : "OFF"}`,
          ...(config.themed ? [`  Themed TUI:       🎨 ON`] : []),
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

      // ── Help ──
      if (trimmed === "help" || trimmed === "?" || trimmed === "h") {
        await ctx.ui.select("cdev subcommands:", [
          "/cdev <task>           Scout + Forge explore",
          "/cdev quick <task>     Scout only (fast)",
          "/cdev verify <task>    Scout ×2 + forge (higher accuracy)",
          "/cdev review [path]    Forge review session/file",
          "/cdev review A..B      Review git/svn diff",
          "/cdev scan [deep]      Generate custom prompts",
          "/cdev history [n]      Past session details",
          "/cdev recall [topic]   Check project memory",
          "/cdev memory refresh <topic>  Re-explore stale topic",
          "/cdev status           Config overview",
          "/cdev memory on|off    Toggle project memory",
          "/cdev prompts on|off   Toggle custom prompts",
          "/cdev themed on|off    Toggle themed TUI",
          "/cdev auto on|off      Toggle auto-trigger",
        ]);
        return;
      }

      // ── Default: task mode ──
      if (!trimmed) {
        await ctx.ui.select("cdev — Model-chained development fork", [
          "Usage: /cdev <task>",
          "",
          "Scout (cheap) explores → Forge (powerful) writes",
          "",
          "Subcommands:",
          "  quick <task>     Scout only (fast findings)",
          "  verify <task>    Scout ×2 + forge (higher accuracy)",
          "  review [path]    Forge review session, file, or diff",
          "  scan [deep]      Generate custom prompts",
          "  history [n]      Past fork sessions",
          "  recall [topic]   Check project memory",
          "  memory refresh <topic>  Re-explore stale topic",
          "  status           Full config overview",
          "  memory on|off    Toggle memory",
          "  prompts on|off   Toggle custom prompts",
          "  themed on|off    Toggle themed TUI",
          "  auto on|off      Toggle auto-trigger",
          "",
          "More: /cdev-help  /cdev-model",
        ]);
        return;
      }

      // ── Fuzzy match ──
      const subcommands = ["status", "quick", "review", "scan", "history", "recall", "view", "info", "memory", "prompts", "auto", "help", "clear"];
      const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
      const isSingleWord = !trimmed.includes(" ");
      const fuzzy = subcommands.find(cmd => {
        if (cmd === firstWord) return false;
        if (cmd.startsWith(firstWord) || firstWord.startsWith(cmd)) return true;
        if (firstWord.length >= 3 && cmd.length >= 3) {
          let diffs = 0;
          const shorter = firstWord.length < cmd.length ? firstWord : cmd;
          for (let i = 0; i < shorter.length; i++) {
            if (firstWord[i] !== cmd[i]) diffs++;
          }
          if (diffs <= 1) return true;
        }
        return false;
      });
      if (fuzzy && isSingleWord) {
        const choice = await ctx.ui.select(
          `Unknown: /cdev ${firstWord}`,
          [
            `→ /cdev ${fuzzy}        (suggested)`,
            `Run as task: /cdev ${firstWord}`,
          ]
        );
        if (!choice) return;
        if (choice.startsWith("→")) return;
      }

      // Not a subcommand → treat as task
      ctx.ui.notify("Queuing cdev task...", "info");
      pi.sendUserMessage(`Use cdev to: ${trimmed}`, { triggerTurn: true, deliverAs: "steer" });
    },
  });
}

export function registerLifecycleHandlers(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  // Purge old sessions and reports, warn about .gitignore on session start
  const purged = purgeOldSessions(ctx.cwd, 7);
  if (purged > 0) {
    ctx.ui.notify(`Purged ${purged} old cdev session${purged > 1 ? "s" : ""} (>7 days)`, "info");
  }

  let purgedReports = 0;
  const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
  if (existsSync(reportsDir)) {
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(reportsDir)) {
      if (!entry.endsWith(".md")) continue;
      if (now - statSync(join(reportsDir, entry)).mtimeMs > week) {
        unlinkSync(join(reportsDir, entry));
        purgedReports++;
      }
    }
  }
  if (purgedReports > 0) {
    ctx.ui.notify(`Purged ${purgedReports} old cdev report${purgedReports > 1 ? "s" : ""} (>7 days)`, "info");
  }

  const sentinelPath = join(ctx.cwd, ".pi", ".cdev-ignore-ok");
  if (!existsSync(sentinelPath)) {
    let warned = false;
    if (existsSync(join(ctx.cwd, ".git"))) {
      const gitignorePath = join(ctx.cwd, ".gitignore");
      if (!existsSync(gitignorePath)) {
        try {
          writeFileSync(gitignorePath, ".pi/\n", "utf-8");
          ctx.ui.notify("Created .gitignore with .pi/ — cdev data now excluded from version control.", "info");
        } catch { /* read-only fs */ }
        warned = true;
      } else {
        const gi = readFileSync(gitignorePath, "utf-8");
        if (!(/^\.pi[/\s]|^\.pi$/m.test(gi) || gi.includes(".pi/"))) {
          ctx.ui.notify(".pi/ is not gitignored — cdev data may leak to version control. Add '.pi/' to .gitignore.", "warn");
          warned = true;
        }
      }
    }
    if (!warned && existsSync(join(ctx.cwd, ".svn"))) {
      try {
        const { spawnSync } = require("node:child_process");
        const result = spawnSync("svn", ["propget", "svn:ignore", "."], { cwd: ctx.cwd, encoding: "utf-8", timeout: 5000 });
        const svnIgnore = (result.stdout || "").trim();
        if (!svnIgnore.split(/[\r\n]+/).some((line: string) => line.trim() === ".pi")) {
          ctx.ui.notify(".pi/ is not in svn:ignore — cdev data may leak to version control. Run: svn propset svn:ignore '.pi' .", "warn");
          warned = true;
        }
      } catch { /* svn not available */ }
    }
    try { mkdirSync(join(ctx.cwd, ".pi"), { recursive: true }); writeFileSync(sentinelPath, "", "utf-8"); } catch {}
  }
}
