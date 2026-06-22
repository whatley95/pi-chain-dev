import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { listSessions, getSession, formatHistory, formatSessionRecord, purgeOldSessions } from "../history.js";
import { memoryClear, getErrorCount, clearErrorLog } from "../memory.js";
import {
  getCdevVersion,
  resolveSignature,
} from "../extension-context.js";
import { handleScan } from "./cdev-scan.js";
import { handleMemory, memoryTopicCount } from "./cdev-memory.js";
import { writeAgentSetting, writeProjectSetting } from "../settings-helpers.js";
import { formatCost } from "../extension-context.js";

function writeProjectThemed(cwd: string, enable: boolean): void {
  writeProjectSetting(cwd, "themed", enable);
}

export function registerCdevCommand(
  pi: ExtensionAPI,
  resetAutoTurnCounter: () => void,
  updateAutoStatus: (ctx: ExtensionContext) => void,
  updatePromptsStatus: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand("cdev", {
    description: "Two-stage chain dev. Subcommands: auto on|off, review [path], quick <task>, verify <task>, status, prompts on|off, history, scan [deep], recall [topic], memory refresh <topic>, themed on|off",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      // ── Subcommand: auto on ──
      if (trimmed === "auto on" || trimmed === "auto") {
        writeAgentSetting("auto", true);
        ctx.ui.notify("cdev auto mode ON — LLM will proactively use cdev for exploration", "info");
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: auto off ──
      if (trimmed === "auto off") {
        writeAgentSetting("auto", false);
        ctx.ui.notify("cdev auto mode OFF", "info");
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      const config = loadConfig(ctx.cwd);

      // ── Subcommands: scan, scan deep ──
      if (await handleScan(trimmed, ctx, config, updatePromptsStatus)) return;

      // ── Subcommands: recall, view, memory *, memory on/off ──
      if (await handleMemory(trimmed, ctx, config)) return;

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

      // ── Subcommand: clear error ──
      if (trimmed === "clear error") {
        const count = getErrorCount(ctx.cwd);
        clearErrorLog(ctx.cwd);
        ctx.ui.notify(`Cleared ${count} error${count !== 1 ? "s" : ""} from cdev error log.`, "info");
        return;
      }

      // ── Subcommand: themed on/off ──
      if (trimmed === "themed on" || trimmed === "themed off") {
        const enable = trimmed === "themed on";
        writeAgentSetting("themed", enable);
        writeProjectThemed(ctx.cwd, enable);
        ctx.ui.notify(`Themed TUI rendering ${enable ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Subcommand: prompts on/off ──
      if (trimmed === "prompts on" || trimmed === "prompts off") {
        const enable = trimmed === "prompts on";
        writeAgentSetting("promptsEnabled", enable);
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
          lines.push(`  Sessions:         ${sessions.length} (7-day window, ${formatCost(totalCost)} total)`);
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
