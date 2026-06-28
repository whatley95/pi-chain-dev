import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AutoForkConfig } from "../config.js";
import { listSessions, getSession, formatHistory, formatSessionRecord, purgeOldSessions, getLastSession } from "../history.js";
import { memoryClear } from "../memory.js";
import { getErrorCount, clearErrorLog } from "../logger.js";
import {
  getCdevVersion,
  resolveSignature,
  resolveStageProfiles,
  estimateSessionSize,
  getSessionForkCost,
  resetSessionForkCost,
  checkSessionCostAlert,
  estimateForkCost,
  formatModelPrice,
  formatCost,
} from "../extension-context.js";
import { handleScan } from "./cdev-scan.js";
import { handleMemory, memoryTopicCount } from "./cdev-memory.js";
import { handleMap, loadProjectMap } from "./cdev-map.js";
import { CDEV_SUBCOMMAND_HELP } from "./cdev-help.js";
import { readAgentSettings, readProjectSettings, writeAgentSetting, writeProjectSetting } from "../settings-helpers.js";
import { normalizeYoloConfig } from "../types.js";

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/(^_+|_+$)/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a.length < b.length) return levenshtein(b, a);
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1).fill(0).map((_, i) => i);
  const curr: number[] = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(
        curr[j] + 1,
        prev[j + 1] + 1,
        prev[j] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function clearReports(reportsDir: string): number {
  if (!existsSync(reportsDir)) return 0;
  let cleared = 0;
  for (const entry of readdirSync(reportsDir)) {
    if (entry.endsWith(".md")) {
      unlinkSync(join(reportsDir, entry));
      cleared++;
    }
  }
  return cleared;
}

function writeProjectThemed(cwd: string, enable: boolean): void {
  writeProjectSetting(cwd, "themed", enable);
}

export function registerCdevCommand(
  pi: ExtensionAPI,
  resetAutoTurnCounter: () => void,
  updateAutoStatus: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand("cdev", {
    description: "Two-stage chain dev. Subcommands: auto on|off, review [path], quick <task>, read <paths>, grep <pattern>, trace <symbol>, explain <path|symbol>, verify <task>, research <issue>, advisor <question>, ask-advisor <question>, plan <task>, status, prompts on|off, history, scan [deep], recall [topic], memory refresh <topic>, themed on|off, todo <name>",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();
      const lower = trimmed.toLowerCase();

      // ── Subcommand: auto on ──
      if (lower === "auto on" || lower === "auto") {
        writeAgentSetting("auto", true);
        ctx.ui.notify("cdev auto mode ON — LLM will proactively use cdev for exploration", "info");
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: auto off ──
      if (lower === "auto off") {
        writeAgentSetting("auto", false);
        ctx.ui.notify("cdev auto mode OFF", "info");
        resetAutoTurnCounter();
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: auto-verify on/off ──
      if (lower === "auto-verify on" || lower === "auto-verify off") {
        const enable = lower === "auto-verify on";
        writeAgentSetting("autoVerify", enable);
        ctx.ui.notify(`cdev auto-verify ${enable ? "ON" : "OFF"} — ${enable ? "scout will run twice automatically" : "scout will run once unless /cdev verify is used"}`, "info");
        return;
      }

      // ── Subcommand: auto-compact on/off ──
      if (lower === "auto-compact on" || lower === "auto-compact off") {
        const enable = lower === "auto-compact on";
        writeAgentSetting("autoCompactOnLimit", enable);
        ctx.ui.notify(`cdev auto-compact ${enable ? "ON" : "OFF"} — ${enable ? "will compact parent session when snapshot nears model limit" : "will only warn near model limit"}`, "info");
        return;
      }

      // ── Subcommand: todo <name> ──
      const todoMatch = trimmed.match(/^todo\s+(.+)$/i);
      if (todoMatch) {
        const rawName = todoMatch[1].trim();
        if (!rawName) {
          ctx.ui.notify("Usage: /cdev todo <name>", "warn");
          return;
        }
        const sessionId = ctx.sessionManager?.getHeader?.()
          ? ((ctx.sessionManager.getHeader() as Record<string, unknown>)?.id as string | undefined) ?? "unknown"
          : "unknown";
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const safeName = sanitizeFileName(rawName) || "task";
        const fileName = `${sessionId}_${timestamp}_${safeName}.md`;
        const todosDir = join(ctx.cwd, ".pi", "cdev", "todos");
        const filePath = join(todosDir, fileName);
        try {
          mkdirSync(todosDir, { recursive: true });
          const template = `# TODO: ${rawName}\n\nCreated: ${now.toISOString()}\nSession: ${sessionId}\n\n## Goal\n\n\n## Checklist\n\n- [ ] \n\n## Notes\n\n`;
          writeFileSync(filePath, template, "utf-8");
        } catch (err) {
          ctx.ui.notify(`Failed to create todo: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        const relativePath = `.pi/cdev/todos/${fileName}`;
        ctx.ui.notify(`Created todo: ${relativePath}`, "info");
        return;
      }

      const config = loadConfig(ctx.cwd);

      // ── Subcommand: read <paths...> ──
      const readMatch = trimmed.match(/^read\s+(.+)$/i);
      if (readMatch) {
        const pathsArg = readMatch[1].trim();
        if (!pathsArg) {
          ctx.ui.notify("Usage: /cdev read <path1> [path2] ...", "warn");
          return;
        }
        const paths = pathsArg.split(/\s+/).map((p) => p.trim()).filter(Boolean);
        if (paths.length === 0) {
          ctx.ui.notify("Usage: /cdev read <path1> [path2] ...", "warn");
          return;
        }
        ctx.ui.notify(`Scout-reading ${paths.length} file${paths.length === 1 ? "" : "s"}...`, "info");
        const task = `Read the following file(s) carefully and return a concise but complete summary for the main agent. Include relevant file paths, function/class names, and line numbers where appropriate. Do not edit any files.\n\n${paths.map((p) => `- ${p}`).join("\n")}`;
        pi.sendUserMessage(`Use cdev with quick=true to: ${task}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: grep <pattern> [path] ──
      const grepMatch = trimmed.match(/^grep\s+(.+)$/i);
      if (grepMatch) {
        const rest = grepMatch[1].trim();
        if (!rest) {
          ctx.ui.notify("Usage: /cdev grep <pattern> [path]", "warn");
          return;
        }
        const tokens = rest.split(/\s+/);
        const lastToken = tokens[tokens.length - 1];
        const hasPath = lastToken && (lastToken.includes("/") || lastToken.includes("\\") || lastToken === "." || lastToken.endsWith("/"));
        const pattern = hasPath ? tokens.slice(0, -1).join(" ") : rest;
        const searchPath = hasPath ? lastToken : ".";
        if (!pattern) {
          ctx.ui.notify("Usage: /cdev grep <pattern> [path]", "warn");
          return;
        }
        ctx.ui.notify(`Scout-grepping for "${pattern}"...`, "info");
        const task = `Search the codebase for occurrences of "${pattern}" under ${searchPath}. Return a concise list of matching file paths, line numbers, and a short snippet for each match. Do not edit any files.`;
        pi.sendUserMessage(`Use cdev with quick=true to: ${task}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: trace <symbol> ──
      const traceMatch = trimmed.match(/^trace\s+(.+)$/i);
      if (traceMatch) {
        const symbol = traceMatch[1].trim();
        if (!symbol) {
          ctx.ui.notify("Usage: /cdev trace <symbol>", "warn");
          return;
        }
        ctx.ui.notify(`Scout-tracing "${symbol}"...`, "info");
        const task = `Trace the symbol "${symbol}" in the codebase. Find its definition(s), declarations, and key call sites/usages. Return file paths, line numbers, and a brief explanation of what it does. Do not edit any files.`;
        pi.sendUserMessage(`Use cdev with quick=true to: ${task}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: explain <path|symbol> ──
      const explainMatch = trimmed.match(/^explain\s+(.+)$/i);
      if (explainMatch) {
        const target = explainMatch[1].trim();
        if (!target) {
          ctx.ui.notify("Usage: /cdev explain <file-path-or-symbol>", "warn");
          return;
        }
        ctx.ui.notify(`Scout-explaining "${target}"...`, "info");
        const task = target.includes("/") || target.includes("\\") || target.endsWith(".ts") || target.endsWith(".js") || target.endsWith(".java") || target.endsWith(".py")
          ? `Explain the file "${target}" in detail. Include its purpose, key functions/classes, important logic, and how it fits into the project. Do not edit any files.`
          : `Explain what "${target}" is in this codebase. Find its definition and main usages, then describe its purpose and behavior. Do not edit any files.`;
        pi.sendUserMessage(`Use cdev with quick=true to: ${task}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommands: scan, scan deep ──
      if (await handleScan(trimmed, ctx, config, updateAutoStatus)) return;

      // ── Subcommands: map, map refresh, map show ──
      if (await handleMap(trimmed, ctx, config)) return;

      // ── Subcommands: recall, view, memory *, memory on/off ──
      if (await handleMemory(trimmed, ctx, config)) return;

      // ── Subcommand: clear ──
      if (lower === "clear") {
        memoryClear(ctx.cwd);
        const cleared = clearReports(join(ctx.cwd, ".pi", "cdev", "reports"));
        ctx.ui.notify(`Cleared cdev project memory${cleared > 0 ? ` + ${cleared} report${cleared !== 1 ? "s" : ""}` : ""}.`, "info");
        return;
      }

      // ── Subcommand: clear reports ──
      if (lower === "clear reports") {
        const cleared = clearReports(join(ctx.cwd, ".pi", "cdev", "reports"));
        ctx.ui.notify(`Cleared ${cleared} cdev report${cleared !== 1 ? "s" : ""}.`, "info");
        return;
      }

      // ── Subcommand: clear error ──
      if (lower === "clear error") {
        const count = getErrorCount(ctx.cwd);
        clearErrorLog(ctx.cwd);
        ctx.ui.notify(`Cleared ${count} error${count !== 1 ? "s" : ""} from cdev error log.`, "info");
        return;
      }

      // ── Subcommand: config ──
      if (await handleConfig(trimmed, ctx, config)) return;

      // ── Subcommand: retry ──
      if (lower === "retry") {
        const last = getLastSession(ctx.cwd);
        if (!last) {
          ctx.ui.notify("No recent cdev session to retry. Run a cdev task first.", "warn");
          return;
        }
        ctx.ui.notify(`Retrying last session: ${last.task}`, "info");
        const params = last.isReview
          ? `Use cdev with review=true to: ${last.task}`
          : `Use cdev to: ${last.task}`;
        pi.sendUserMessage(params, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: estimate <task> ──
      const estimateMatch = trimmed.match(/^estimate\s+(.+)$/i);
      if (estimateMatch) {
        const estimateTask = estimateMatch[1].trim();
        if (!estimateTask) {
          ctx.ui.notify("Usage: /cdev estimate <task>", "warn");
          return;
        }
        const profiles = resolveStageProfiles(config);
        if (profiles.warning) {
          ctx.ui.notify(profiles.warning, "warn");
          return;
        }
        const estimate = estimateForkCost({
          task: estimateTask,
          stage1Profile: profiles.stage1,
          stage2Profile: profiles.stage2,
          forkSessionSnapshotJsonl: "",
        });
        ctx.ui.notify(`Estimated cost: ~${formatCost(estimate.cost)}\nTokens: ~${estimate.inputTokens} in / ~${estimate.outputTokens} out\nModels: ${profiles.stage1.id} → ${profiles.stage2.id}`, "info");
        return;
      }

      // ── Subcommand: cost ──
      if (lower === "cost" || lower === "cost reset") {
        if (lower === "cost reset") {
          resetSessionForkCost(ctx.cwd);
          ctx.ui.notify("cdev session cost reset to $0.00.", "info");
          return;
        }
        const sessionCost = getSessionForkCost(ctx.cwd);
        const alert = checkSessionCostAlert(config, ctx.cwd);
        ctx.ui.notify(`cdev session cost: ${formatCost(sessionCost)}${alert ? `  ${alert.level === "critical" ? "🔴" : "🟡"} ${(alert.percent * 100).toFixed(0)}% of budget` : ""}`, "info");
        return;
      }

      // ── Subcommand: themed on/off ──
      if (lower === "themed on" || lower === "themed off") {
        const enable = lower === "themed on";
        writeAgentSetting("themed", enable);
        writeProjectThemed(ctx.cwd, enable);
        ctx.ui.notify(`Themed TUI rendering ${enable ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Subcommand: prompts on/off ──
      if (lower === "prompts on" || lower === "prompts off") {
        const enable = lower === "prompts on";
        writeAgentSetting("promptsEnabled", enable);
        ctx.ui.notify(`Custom prompts ${enable ? "ON" : "OFF"}`, "info");
        updateAutoStatus(ctx);
        return;
      }

      // ── Subcommand: history ──
      const historyMatch = trimmed.match(/^history(?:\s+(\d+))?$/i);
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

      // ── Subcommand: replay <n> ──
      const replayMatch = trimmed.match(/^replay\s+(\d+)$/i);
      if (replayMatch) {
        const sessionNum = parseInt(replayMatch[1], 10);
        const session = getSession(ctx.cwd, sessionNum);
        if (!session) {
          ctx.ui.notify(`No session #${sessionNum}. Try /cdev history to list.`, "warn");
          return;
        }
        ctx.ui.notify(`Replaying session #${sessionNum}: ${session.task}`, "info");
        const modePrefix = session.isReview ? "review" : "";
        const message = modePrefix
          ? `Use cdev with ${modePrefix}=true to: ${session.task}`
          : `Use cdev to: ${session.task}`;
        pi.sendUserMessage(message, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: review [path|diff] ──
      const reviewFileMatch = trimmed.match(/^review\s+(.+)$/i);
      if (lower === "review" || reviewFileMatch) {
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
          if (/^(changes|change|uncommitted|uncommitted changes|working tree|worktree)$/i.test(cleanArg)) {
            const vcs = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: ctx.cwd, encoding: "utf-8" }).status === 0
              ? "git"
              : spawnSync("svn", ["info"], { cwd: ctx.cwd, encoding: "utf-8" }).status === 0
                ? "svn"
                : null;
            if (!vcs) {
              ctx.ui.notify("This directory is not inside a git or svn repository. Review a file with /cdev review <path> instead.", "warn");
              return;
            }
            ctx.ui.notify("Reviewing uncommitted changes…", "info");
            pi.sendUserMessage(`Review uncommitted changes using cdev with review=true, diffSpec="HEAD".`, { triggerTurn: true, deliverAs: "steer" });
            return;
          }
          // Diff specs look like "HEAD~3..HEAD", "main..feature", "r1234:1235", or "r1234-1235".
          // A plain relative path such as "../src/foo.ts" should not match.
          const isDiff = (/^[^/\\]+\.\.[^/\\]*$/.test(cleanArg) || /^r\d+[-:]\d+$/.test(cleanArg)) &&
                         !/[\\/]/.test(cleanArg);
          const looksLikePath = /[\\/]/.test(cleanArg) || /\.[a-z]{2,6}$/i.test(cleanArg);
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

      // ── Subcommand: quick / fast ──
      if (lower.startsWith("quick ") || lower.startsWith("fast ")) {
        const quickTask = trimmed.slice(6).trim();
        if (!quickTask) {
          ctx.ui.notify("Usage: /cdev quick <task> or /cdev fast <task>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing quick exploration (stage 1 only)...`, "info");
        pi.sendUserMessage(`Use cdev with quick=true to: ${quickTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: verify ──
      if (lower.startsWith("verify ")) {
        const verifyTask = trimmed.slice(7).trim();
        if (!verifyTask) {
          ctx.ui.notify("Usage: /cdev verify <task>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing verified exploration (scout ×2 + forge)...`, "info");
        pi.sendUserMessage(`Use cdev with verify=true to: ${verifyTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: research ──
      if (lower.startsWith("research ")) {
        const researchTask = trimmed.slice(9).trim();
        if (!researchTask) {
          ctx.ui.notify("Usage: /cdev research <issue or question>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing research investigation (agent-driven, no edits)...`, "info");
        pi.sendUserMessage(`Use cdev with research=true to: ${researchTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: advisor ──
      if (lower.startsWith("advisor ")) {
        const advisorQuestion = trimmed.slice(8).trim();
        if (!advisorQuestion) {
          ctx.ui.notify("Usage: /cdev advisor <question>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing advisor (scout + advisor)...`, "info");
        pi.sendUserMessage(`Use cdev with advisor=true to: ${advisorQuestion}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: ask-advisor ──
      if (lower.startsWith("ask-advisor ")) {
        const advisorQuestion = trimmed.slice(12).trim();
        if (!advisorQuestion) {
          ctx.ui.notify("Usage: /cdev ask-advisor <question>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing ask-advisor (advisor only)...`, "info");
        pi.sendUserMessage(`Use cdev with advisor=true, askAdvisor=true to: ${advisorQuestion}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: multi n [no-backup] task ──
      const multiMatch = trimmed.match(/^multi\s+(\d{1,2})(?:\s+(backup|no-backup))?\s+(.+)$/i);
      if (multiMatch) {
        const n = parseInt(multiMatch[1], 10);
        const backupFlag = multiMatch[2]?.toLowerCase();
        const useBackup = backupFlag === "backup" || (backupFlag === undefined && (config.parallelBackup ?? false));
        const multiTask = multiMatch[3].trim();
        if (n < 1 || n > 3 || !multiTask) {
          ctx.ui.notify("Usage: /cdev multi <1-3> [backup|no-backup] <task>", "warn");
          return;
        }
        if (!loadProjectMap(ctx.cwd)) {
          ctx.ui.notify("Project map missing. Run /cdev map first to enable multi scouting.", "warn");
          return;
        }
        ctx.ui.notify(`Queuing multi exploration (${n} scout${n > 1 ? "s" : ""}${useBackup ? ", backup on" : ", backup off"})...`, "info");
        pi.sendUserMessage(`Use cdev with parallel=${n}, parallelBackup=${useBackup} to: ${multiTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: plan ──
      if (lower.startsWith("plan ")) {
        const planTask = trimmed.slice(5).trim();
        if (!planTask) {
          ctx.ui.notify("Usage: /cdev plan <task>", "warn");
          return;
        }
        ctx.ui.notify(`Queuing implementation plan (scout + planner)...`, "info");
        pi.sendUserMessage(`Use cdev with plan=true to: ${planTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: yolo on|off ──
      if (lower === "yolo on" || lower === "yolo off") {
        const enable = lower === "yolo on";
        const currentYolo = normalizeYoloConfig(config.yolo);
        writeAgentSetting("yolo", { ...currentYolo, enabled: enable });
        ctx.ui.notify(`cdev yolo mode ${enable ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Subcommand: yolo mode manual|propose|auto ──
      const yoloModeMatch = trimmed.match(/^yolo\s+(manual|propose|auto)$/i);
      if (yoloModeMatch) {
        const mode = yoloModeMatch[1] as "manual" | "propose" | "auto";
        const currentYolo = normalizeYoloConfig(config.yolo);
        writeAgentSetting("yolo", { ...currentYolo, autoApply: mode });
        const note = mode === "auto" ? " ⚠️ cdev will edit files automatically" : "";
        ctx.ui.notify(`cdev yolo auto-apply set to ${mode}${note}`, "info");
        return;
      }

      // ── Subcommand: yolo usage ──
      if (lower === "yolo") {
        ctx.ui.notify("Usage:\n/cdev yolo <task>            Scout + forge, then review loops\n/cdev yolo on|off            Toggle yolo mode\n/cdev yolo manual|propose|auto  Set who applies fixes (manual=main agent, propose=cdev plan, auto=cdev edits)", "info");
        return;
      }

      // ── Subcommand: yolo <task> ──
      if (lower.startsWith("yolo ")) {
        const yoloTask = trimmed.slice(5).trim();
        if (!yoloTask) {
          ctx.ui.notify("Usage: /cdev yolo <task>", "warn");
          return;
        }
        const yolo = normalizeYoloConfig(config.yolo);
        if (!yolo.enabled) {
          ctx.ui.notify("YOLO mode is disabled. Enable with /cdev yolo on", "warn");
          return;
        }
        const autoApplyNote = yolo.autoApply === "auto" ? " [AUTO-EDIT]" : yolo.autoApply === "propose" ? " [propose fixes]" : " [main agent fixes]";
        ctx.ui.notify(`Queuing YOLO task (max ${yolo.maxRounds} rounds${autoApplyNote})...`, "info");
        pi.sendUserMessage(`Use cdev with yolo=true to: ${yoloTask}`, { triggerTurn: true, deliverAs: "steer" });
        return;
      }

      // ── Subcommand: status ──
      if (lower === "status" || lower === "info") {
        ctx.ui.notify(formatCdevStatus(ctx, config), "info");
        return;
      }

      // ── Help ──
      if (lower === "help" || lower === "?" || lower === "h") {
        await ctx.ui.select("cdev subcommands:", CDEV_SUBCOMMAND_HELP);
        return;
      }

      // ── Default: task mode ──
      if (!trimmed) {
        const choice = await ctx.ui.select("cdev — choose workflow", [
          "Review uncommitted changes",
          "Quick explore",
          "Deep verify",
          "Research issue",
          "Advisor question",
          "Ask advisor directly",
          "Multi explore",
          "Plan implementation",
          "Review current session",
          "Review file or diff",
          "Show status",
          "Show history",
          "Help",
        ]);
        if (!choice) return;
        if (choice === "Review uncommitted changes") {
          ctx.ui.notify("Reviewing uncommitted changes…", "info");
          pi.sendUserMessage(`Review uncommitted changes using cdev with review=true, diffSpec="HEAD".`, { triggerTurn: true, deliverAs: "steer" });
          return;
        }
        if (choice === "Review current session") {
          ctx.ui.notify("Queuing current session review…", "info");
          pi.sendUserMessage("Run a code review using the cdev tool with review=true.", { triggerTurn: true, deliverAs: "steer" });
          return;
        }
        if (choice === "Show history") {
          const sessions = listSessions(ctx.cwd);
          ctx.ui.notify(formatHistory(sessions), "info");
          return;
        }
        if (choice === "Show status") {
          ctx.ui.notify("Use /cdev status for the full config, model, budget, memory, and session overview.", "info");
          return;
        }
        if (choice === "Help") {
          ctx.ui.notify("Use /cdev-help for all subcommands, or /cdev-model to pick scout and forge models.", "info");
          return;
        }
        if (choice === "Multi explore") {
          const nStr = await ctx.ui.input("Number of parallel scouts (1-3):");
          const n = nStr ? parseInt(nStr.trim(), 10) : NaN;
          if (Number.isNaN(n) || n < 1 || n > 3) {
            ctx.ui.notify("Cancelled or invalid scout count.", "warn");
            return;
          }
          const backupStr = await ctx.ui.select("Use backup scout on failure?", ["Yes", "No"]);
          const useBackup = backupStr === "Yes";
          if (!loadProjectMap(ctx.cwd)) {
            ctx.ui.notify("Project map missing. Run /cdev map first to enable multi scouting.", "warn");
            return;
          }
          const task = await ctx.ui.input("Task for the parallel scouts:");
          if (!task || !task.trim()) {
            ctx.ui.notify("Cancelled — no task provided.", "warn");
            return;
          }
          ctx.ui.notify(`Queuing multi exploration (${n} scout${n > 1 ? "s" : ""}${useBackup ? ", backup on" : ", backup off"})...`, "info");
          pi.sendUserMessage(`Use cdev with parallel=${n}, parallelBackup=${useBackup} to: ${task.trim()}`, { triggerTurn: true, deliverAs: "steer" });
          return;
        }
        const usage: Record<string, string> = {
          "Quick explore": "/cdev quick <task>",
          "Deep verify": "/cdev verify <task>",
          "Research issue": "/cdev research <issue or question>",
          "Advisor question": "/cdev advisor <question>",
          "Ask advisor directly": "/cdev ask-advisor <question>",
          "Multi explore": "/cdev multi <1-3> [backup|no-backup] <task>",
          "Plan implementation": "/cdev plan <task>",
          "Review file or diff": "/cdev review <path-or-diff>",
        };
        ctx.ui.notify(`${choice}: ${usage[choice] ?? "/cdev <task>"}`, "info");
        return;
      }

      // ── Fuzzy match ──
       const subcommands = ["status", "quick", "fast", "review", "scan", "history", "recall", "view", "info", "memory", "prompts", "auto", "auto-verify", "auto-compact", "config", "retry", "estimate", "help", "clear", "yolo", "verify", "plan", "multi", "research", "advisor", "ask-advisor"];
      const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
      const isSingleWord = !trimmed.includes(" ");
      const fuzzy = subcommands
        .filter(cmd => cmd !== firstWord)
        .map(cmd => ({ cmd, dist: levenshtein(firstWord, cmd) }))
        .filter(({ dist }) => dist <= 2)
        .sort((a, b) => a.dist - b.dist)[0]?.cmd;
      if (fuzzy && isSingleWord) {
        const choice = await ctx.ui.select(
          `Unknown: /cdev ${firstWord}`,
          [
            `→ /cdev ${fuzzy}        (suggested)`,
            `Run as task: /cdev ${firstWord}`,
          ]
        );
        if (!choice) return;
        if (choice.startsWith("→")) {
          const rest = trimmed.slice(firstWord.length).trim();
          const newCmd = rest ? `/cdev ${fuzzy} ${rest}` : `/cdev ${fuzzy}`;
          ctx.ui.notify(`Running ${newCmd}...`, "info");
          pi.sendUserMessage(newCmd, { triggerTurn: true, deliverAs: "steer" });
          return;
        }
      }

      // Not a subcommand → treat as task
      ctx.ui.notify("Queuing cdev task...", "info");
      pi.sendUserMessage(`Use cdev to: ${trimmed}`, { triggerTurn: true, deliverAs: "steer" });
    },
  });
}

function formatCdevStatus(ctx: ExtensionContext, config: AutoForkConfig): string {
  const resolved = resolveStageProfiles(config);
  const isConfigured = resolved.stage1.provider && resolved.stage1.id && resolved.stage2.provider && resolved.stage2.id;
  const sessionSize = estimateSessionSize(ctx);
  const sessionCost = getSessionForkCost(ctx.cwd);
  const costAlert = checkSessionCostAlert(config, ctx.cwd);
  const sessions = listSessions(ctx.cwd);
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  let todayCost = 0;
  let totalCost = 0;
  for (const s of sessions) {
    const c = (s.stage1?.cost ?? 0) + (s.stage2?.cost ?? 0);
    totalCost += c;
    if (new Date(s.startedAt).getTime() > now - oneDay) {
      todayCost += c;
    }
  }

  const lines: string[] = [
    "── cdev status ─────────────────────────────────────",
    "",
    `  👤 ${resolveSignature(config)}`,
    `  Version:          ${getCdevVersion(ctx.cwd)}`,
    "",
  ];
  if (!isConfigured) {
    lines.push(`  ⚠️  ${resolved.warning ?? "cdev is not configured. Use /cdev-model to set scout and forge models."}`);
    lines.push("");
  }
  lines.push(`  Current model:    ${ctx.model ? ctx.model.id : "none"}`);
  lines.push(`  Scout A:          ${config.stage1.provider}:${config.stage1.id}  •  ${config.stage1.thinking}`);
  if (config.stage1b?.provider && config.stage1b?.id) {
    lines.push(`  Scout B:          ${config.stage1b.provider}:${config.stage1b.id}  •  ${config.stage1b.thinking}`);
  } else {
    lines.push(`  Scout B:          ↳ Scout A (${config.stage1.id})`);
  }
  if (config.stage1c?.provider && config.stage1c?.id) {
    lines.push(`  Scout C:          ${config.stage1c.provider}:${config.stage1c.id}  •  ${config.stage1c.thinking}`);
  } else {
    lines.push(`  Scout C:          ↳ Scout A (${config.stage1.id})`);
  }
  if (config.stage1Backup?.provider && config.stage1Backup?.id) {
    lines.push(`  Backup scout:     ${config.stage1Backup.provider}:${config.stage1Backup.id}  •  ${config.stage1Backup.thinking}`);
  } else {
    lines.push(`  Backup scout:     ↳ Scout A (${config.stage1.id})`);
  }
  lines.push(`  Forge:            ${config.stage2.provider}:${config.stage2.id}  •  ${config.stage2.thinking}`);
  lines.push(`  Review:           ${config.review ? `${config.review.provider}:${config.review.id}  •  ${config.review.thinking}` : `↳ Forge (${config.stage2.id})`}`);
  lines.push(`  Research:         ${config.research ? `${config.research.provider}:${config.research.id}  •  ${config.research.thinking}` : `↳ Scout A (${config.stage1.id})`}`);
  lines.push(`  Advisor:          ${config.advisor ? `${config.advisor.provider}:${config.advisor.id}  •  ${config.advisor.thinking}` : `↳ Forge (${config.stage2.id})`}`);
  lines.push(`  Model prices:     Scout A ${formatModelPrice(config.stage1.id)}  |  Forge ${formatModelPrice(config.stage2.id)}`);
  lines.push(`  Auto-trigger:     ${config.auto ? "⚡ ON (sends steer every 3 turns to prompt cdev use)" : "OFF (agent uses cdev only when asked or it decides)"}`);
  lines.push(`  Custom prompts:   ${config.prompts?.explore || config.prompts?.review ? (config.promptsEnabled ? "📋 ON (custom)" : "📋✕ OFF (custom exists)") : "— (none)"}`);
  lines.push(`  Cost footer:      ${config.costFooter ? "ON" : "OFF"}`);
  lines.push(`  Project memory:   ${config.memory ? "ON" : "OFF"}`);
  lines.push(`  Memory auto-refresh: ${config.memoryAutoRefresh ? "ON" : "OFF"}`);
  lines.push(`  Auto-verify:      ${config.autoVerify ? "✓ ON (scout ×2)" : "OFF (scout ×1)"}`);
  lines.push(`  Multi scouts:     ${config.parallel && config.parallel > 1 ? `${config.parallel} (backup ${config.parallelBackup ? "on" : "off"})` : "OFF"}`);
  lines.push(`  Scout timeout:    ${((config.profileTimeouts?.scout ?? config.scoutTimeoutMs ?? 600_000) / 1000).toFixed(0)}s${config.profileTimeouts?.scout ? " (profile override)" : ""}`);
  lines.push(`  Forge timeout:    ${((config.profileTimeouts?.forge ?? config.forgeTimeoutMs ?? 180_000) / 1000).toFixed(0)}s${config.profileTimeouts?.forge ? " (profile override)" : ""}`);
  const yolo = normalizeYoloConfig(config.yolo);
  lines.push(`  YOLO:             ${yolo.enabled ? `🚀 ON (max ${yolo.maxRounds} rounds, ${yolo.autoApply === "auto" ? "auto-edit" : yolo.autoApply === "propose" ? "propose fixes" : "main agent fixes"})` : "OFF"}`);
  const hasMap = !!loadProjectMap(ctx.cwd);
  lines.push(`  Project map:      ${hasMap ? "🗺️ present  /cdev map show" : "— missing  /cdev map"}`);
  const usage = ctx.getContextUsage?.();
  const usageLine = usage
    ? `  Context usage:    ${usage.tokens !== null ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens  ${usage.percent !== null ? `(${usage.percent.toFixed(1)}%)` : ""}` : "unknown"}`
    : "";
  lines.push(`  Session size:     ${sessionSize} message${sessionSize === 1 ? "" : "s"}${sessionSize >= 40 ? "  ⚠️ consider /compact" : ""}`);
  if (usageLine) lines.push(usageLine);
  lines.push(`  Context limit:    ${(usage?.contextWindow ?? config.modelContextLimit ?? 262_144).toLocaleString()} tokens  (auto-compact ${config.autoCompactOnLimit ? "ON" : "OFF"}${typeof config.tokenEstimationCharsPerToken === "number" ? ", " + config.tokenEstimationCharsPerToken + " chars/token fallback" : ""})`);
  lines.push(`  Session cost:     ${formatCost(sessionCost)}${config.maxSessionCost ? ` / ${formatCost(config.maxSessionCost)}` : ""}${costAlert ? `  ${costAlert.level === "critical" ? "🔴" : "🟡"} ${(costAlert.percent * 100).toFixed(0)}% of budget` : ""}`);
  lines.push(`  Today's cost:     ${formatCost(todayCost)}  (cdev forks only — excludes main agent usage)`);
  if (config.themed) {
    lines.push(`  Themed TUI:       🎨 ON`);
  }
  lines.push(`  Offline mode:     ${config.offline ? "ON" : "OFF"}`);
  lines.push(`  Extensions:       ${config.extensions === null ? "inherit" : config.extensions.length === 0 ? "none" : config.extensions.join(", ")}`);
  lines.push("");
  if (sessions.length > 0) {
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
  return lines.join("\n");
}

function formatConfigValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "number") return Number.isInteger(value) ? value.toString() : value.toFixed(4);
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.provider && obj.id) return `${obj.provider}:${obj.id} • ${obj.thinking ?? "?"}`;
  }
  return JSON.stringify(value);
}

function parseBooleanValue(raw: string): boolean | null {
  const lower = raw.toLowerCase();
  if (["on", "true", "yes", "1"].includes(lower)) return true;
  if (["off", "false", "no", "0"].includes(lower)) return false;
  return null;
}

const CONFIG_KEYS: Record<string, { type: "boolean" | "number" | "seconds" | "profileTimeouts"; min?: number; max?: number }> = {
  auto: { type: "boolean" },
  autoVerify: { type: "boolean" },
  autoCompactOnLimit: { type: "boolean" },
  memory: { type: "boolean" },
  memoryAutoRefresh: { type: "boolean" },
  promptsEnabled: { type: "boolean" },
  themed: { type: "boolean" },
  parallelBackup: { type: "boolean" },
  parallel: { type: "number", min: 1, max: 3 },
  scoutTimeoutMs: { type: "seconds", min: 30, max: 3600 },
  forgeTimeoutMs: { type: "seconds", min: 30, max: 3600 },
  profileTimeouts: { type: "profileTimeouts" },
  modelContextLimit: { type: "number", min: 8192, max: 2000000 },
  tokenEstimationCharsPerToken: { type: "number", min: 1, max: 64 },
  maxForkCost: { type: "number", min: 0 },
  maxSessionCost: { type: "number", min: 0 },
};

async function handleConfig(trimmed: string, ctx: ExtensionContext, config: AutoForkConfig): Promise<boolean> {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("config")) return false;
  const rest = trimmed.slice(6).trim();

  if (!rest) {
    const agent = readAgentSettings();
    const project = readProjectSettings(ctx.cwd);
    const lines = [
      "── cdev config ─────────────────────────────────────",
      "",
      "Key                          | Value        | Source",
      "─────────────────────────────────────────────────────",
    ];
    for (const key of Object.keys(CONFIG_KEYS)) {
      const value = (config as unknown as Record<string, unknown>)[key];
      const source = project[key] !== undefined ? "project" : agent[key] !== undefined ? "agent" : "default";
      lines.push(`${key.padEnd(28)} | ${formatConfigValue(value).padEnd(12)} | ${source}`);
    }
    lines.push("");
    lines.push("Profiles:");
    lines.push(`  stage1  ${formatConfigValue(config.stage1)}`);
    lines.push(`  stage2  ${formatConfigValue(config.stage2)}`);
    if (config.review) lines.push(`  review  ${formatConfigValue(config.review)}`);
    if (config.research) lines.push(`  research ${formatConfigValue(config.research)}`);
    lines.push("");
    lines.push("Usage: /cdev config <key> <value>");
    lines.push("       /cdev config project <key> <value>");
    lines.push("─────────────────────────────────────────────────────");
    ctx.ui.notify(lines.join("\n"), "info");
    return true;
  }

  const parts = rest.split(/\s+/);
  const isProject = parts[0] === "project";
  if (isProject) parts.shift();

  // Handle nested profileTimeouts keys: profileTimeouts.scout, profileTimeouts.forge, etc.
  if (parts.length >= 1 && parts[0].startsWith("profileTimeouts.")) {
    const nestedKey = parts[0].slice("profileTimeouts.".length);
    const validFields = ["scout", "forge", "research", "review", "yoloReview", "yoloFix"];
    if (!validFields.includes(nestedKey)) {
      ctx.ui.notify(`Unknown profileTimeouts field "${nestedKey}". Use one of: ${validFields.join(", ")}`, "warn");
      return true;
    }
    if (parts.length === 1) {
      const value = (config.profileTimeouts as Record<string, unknown> | undefined)?.[nestedKey];
      ctx.ui.notify(`profileTimeouts.${nestedKey}: ${formatConfigValue(value)}`, "info");
      return true;
    }
    const rawValue = parts.slice(1).join(" ");
    const seconds = parseInt(rawValue, 10);
    if (Number.isNaN(seconds)) {
      ctx.ui.notify(`Invalid number "${rawValue}".`, "warn");
      return true;
    }
    const clamped = Math.max(30, Math.min(3600, seconds));
    const merged: Record<string, number> = { ...(config.profileTimeouts ?? {}) };
    merged[nestedKey] = clamped * 1000;
    if (isProject) {
      writeProjectSetting(ctx.cwd, "profileTimeouts", merged);
      ctx.ui.notify(`Set project config profileTimeouts.${nestedKey} = ${clamped}s`, "info");
    } else {
      writeAgentSetting("profileTimeouts", merged);
      ctx.ui.notify(`Set agent config profileTimeouts.${nestedKey} = ${clamped}s`, "info");
    }
    return true;
  }

  if (parts.length === 1) {
    const key = parts[0];
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value === undefined) {
      ctx.ui.notify(`Unknown config key "${key}". Use /cdev config to list keys.`, "warn");
      return true;
    }
    ctx.ui.notify(`${key}: ${formatConfigValue(value)}`, "info");
    return true;
  }

  if (parts.length >= 2) {
    const key = parts[0];
    const rawValue = parts.slice(1).join(" ");
    const schema = CONFIG_KEYS[key];
    if (!schema) {
      ctx.ui.notify(`Unknown config key "${key}". Use /cdev config to list keys.`, "warn");
      return true;
    }

    let parsed: unknown;
    if (schema.type === "boolean") {
      const bool = parseBooleanValue(rawValue);
      if (bool === null) {
        ctx.ui.notify(`Invalid boolean value "${rawValue}". Use on/off or true/false.`, "warn");
        return true;
      }
      parsed = bool;
    } else if (schema.type === "seconds") {
      const seconds = parseInt(rawValue, 10);
      if (Number.isNaN(seconds)) {
        ctx.ui.notify(`Invalid number "${rawValue}".`, "warn");
        return true;
      }
      const clamped = Math.max(schema.min ?? 1, Math.min(schema.max ?? Number.MAX_SAFE_INTEGER, seconds));
      parsed = clamped * 1000;
    } else if (schema.type === "profileTimeouts") {
      ctx.ui.notify(`Use /cdev config profileTimeouts.<field> <seconds> where field is one of: scout, forge, research, review, yoloReview, yoloFix`, "warn");
      return true;
    } else {
      const num = parseFloat(rawValue);
      if (Number.isNaN(num)) {
        ctx.ui.notify(`Invalid number "${rawValue}".`, "warn");
        return true;
      }
      parsed = Math.max(schema.min ?? -Infinity, Math.min(schema.max ?? Infinity, num));
    }

    if (isProject) {
      writeProjectSetting(ctx.cwd, key, parsed);
      ctx.ui.notify(`Set project config ${key} = ${formatConfigValue(parsed)}`, "info");
    } else {
      writeAgentSetting(key, parsed);
      ctx.ui.notify(`Set agent config ${key} = ${formatConfigValue(parsed)}`, "info");
    }
    return true;
  }

  return false;
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
    if (!warned) {
      try { mkdirSync(join(ctx.cwd, ".pi"), { recursive: true }); writeFileSync(sentinelPath, "", "utf-8"); } catch { /* ignore */ }
    }
  }
}
