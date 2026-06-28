/**
 * Status formatter for cdev.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkConfig } from "../config.js";
import { resolveStageProfiles, estimateSessionSize, getSessionForkCost, checkSessionCostAlert, getCdevVersion, resolveSignature, formatModelPrice, formatCost } from "../extension-context.js";
import { listSessions } from "../history.js";
import { memoryTopicCount } from "./cdev-memory.js";
import { loadProjectMap } from "./cdev-map.js";
import { getErrorCount } from "../logger.js";
import { normalizeYoloConfig } from "../types.js";

export function formatCdevStatus(ctx: ExtensionContext, config: AutoForkConfig): string {
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
    if (new Date(s.startedAt).getTime() > now - oneDay) todayCost += c;
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
  lines.push(`  Scout B:          ${config.stage1b?.provider && config.stage1b?.id ? `${config.stage1b.provider}:${config.stage1b.id}  •  ${config.stage1b.thinking}` : `↳ Scout A (${config.stage1.id})`}`);
  lines.push(`  Scout C:          ${config.stage1c?.provider && config.stage1c?.id ? `${config.stage1c.provider}:${config.stage1c.id}  •  ${config.stage1c.thinking}` : `↳ Scout A (${config.stage1.id})`}`);
  lines.push(`  Backup scout:     ${config.stage1Backup?.provider && config.stage1Backup?.id ? `${config.stage1Backup.provider}:${config.stage1Backup.id}  •  ${config.stage1Backup.thinking}` : `↳ Scout A (${config.stage1.id})`}`);
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
  lines.push(`  Session size:     ${sessionSize} message${sessionSize === 1 ? "" : "s"}${sessionSize >= 40 ? "  ⚠️ consider /compact" : ""}`);
  if (usage && usage.tokens !== null) {
    lines.push(`  Context usage:    ${usage.tokens.toLocaleString()} / ${(usage.contextWindow ?? config.modelContextLimit ?? 262_144).toLocaleString()} tokens  ${usage.percent !== null ? `(${usage.percent.toFixed(1)}%)` : ""}`);
  }
  lines.push(`  Context limit:    ${(usage?.contextWindow ?? config.modelContextLimit ?? 262_144).toLocaleString()} tokens  (auto-compact ${config.autoCompactOnLimit ? "ON" : "OFF"}${typeof config.tokenEstimationCharsPerToken === "number" ? ", " + config.tokenEstimationCharsPerToken + " chars/token fallback" : ""})`);
  lines.push(`  Session cost:     ${formatCost(sessionCost)}${config.maxSessionCost ? ` / ${formatCost(config.maxSessionCost)}` : ""}${costAlert ? `  ${costAlert.level === "critical" ? "🔴" : "🟡"} ${(costAlert.percent * 100).toFixed(0)}% of budget` : ""}`);
  lines.push(`  Today's cost:     ${formatCost(todayCost)}  (cdev forks only)`);
  lines.push(`  Themed TUI:       ${config.themed ? "🎨 ON" : "OFF"}`);
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
