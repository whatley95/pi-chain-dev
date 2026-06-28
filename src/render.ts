/**
 * TUI renderers for the cdev tool.
 *
 * pi-chain-dev embeds custom renderCall / renderResult so the activity panel
 * shows the fork's progress and outcome instead of generic JSON.
 */

import { formatCost } from "./extension-context.js";
import { fmtDuration } from "./format.js";
import type { Component, Theme } from "@earendil-works/pi-tui";
import { keyHint, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bg as themeBg } from "./theme-utils.js";
import type { AutoForkDetails, AutoForkUiDetails } from "./types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const MAX_TASK_CHARS = 60;
const MAX_PREVIEW_CHARS = 200;

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function fmtCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  return formatCost(cost);
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  } catch { return null; }
}

/** TTL cache for isThemed() to avoid disk reads on every render call. */
let _themedCache: { cwd: string; result: boolean; ts: number } | null = null;
const THEMED_CACHE_TTL_MS = 300000; // 5 minutes (was 5s — settings rarely change mid-session)

function isThemed(cwd?: string): boolean {
  const cacheKey = cwd ?? "";
  // Use cached result if within TTL
  if (_themedCache && _themedCache.cwd === cacheKey && Date.now() - _themedCache.ts < THEMED_CACHE_TTL_MS) {
    return _themedCache.result;
  }
  let result = false;
  if (!cwd) { _themedCache = { cwd: cacheKey, result: false, ts: Date.now() }; return false; }
  try {
    // Project-local settings (overrides global)
    const proj = readJsonSafe(join(cwd, ".pi", "settings.json"));
    const projCdev = (proj?.["pi-chain-dev"] ?? proj?.["pi-auto-fork"]) as Record<string, unknown> | undefined;
    // Global agent settings (fallback)
    const global = readJsonSafe(join(getAgentDir(), "settings.json"));
    const globalCdev = global?.["pi-chain-dev"] as Record<string, unknown> | undefined;
    // Project overrides global, default true
    result = (projCdev?.["themed"] ?? globalCdev?.["themed"]) !== false;
  } catch { /* result stays false */ }
  _themedCache = { cwd: cacheKey, result, ts: Date.now() };
  return result;
}

/** Wrap text in theme background if themed mode is on. Falls back to ANSI if token missing. */
function bg(token: string, text: string, theme: Theme, themed: boolean): string {
  return themeBg(token, text, theme, themed);
}

// ---------------------------------------------------------------------------
// renderCall
// ---------------------------------------------------------------------------

export function renderCall(args: unknown, theme: Theme, _context?: { cwd?: string }): Component {
  const a = args as Record<string, unknown>;
  const fg = theme.fg.bind(theme);
  const themed = isThemed(_context?.cwd);
  const task = typeof a?.task === "string" && (a.task as string).trim()
    ? trunc((a.task as string).replace(/\s+/g, " ").trim(), MAX_TASK_CHARS)
    : "";

  let label: string;
  if (typeof a?.recall === "string") {
    label = a.recall ? `cdev-recall "${a.recall}"` : "cdev-recall (list)";
  } else if (a?.review) {
    label = "cdev-review";
  } else if (a?.plan) {
    label = task ? `cdev-plan "${task}"` : "cdev-plan";
  } else if (a?.yolo) {
    label = task ? `cdev-yolo "${task}"` : "cdev-yolo";
  } else if (a?.quick) {
    label = task ? `cdev-quick "${task}"` : "cdev-quick";
  } else {
    label = task ? `cdev "${task}"` : "cdev";
  }

  return new SimpleText(bg("toolPendingBg", fg("toolTitle", label), theme, themed)) as unknown as Component;
}

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

export function renderResult(
  toolResult: unknown,
  opts: { expanded: boolean },
  theme: Theme,
  _context?: { cwd?: string },
): Component {
  const fg = theme.fg.bind(theme);
  const themed = isThemed(_context?.cwd);
  const result = toolResult as { isError?: boolean; content?: Array<{ type: string; text: string }>; details?: AutoForkDetails };
  const isErr = Boolean(result?.isError);
  const content = result?.content;
  const details = result?.details;
  const ui = details?.ui ?? {};
  const textOut = Array.isArray(content)
    ? content.map((p: { type: string; text: string }) => p?.text ?? "").join("\n").trim()
    : "";

  const taskText = ui?.task
    ? trunc(String(ui.task).replace(/\s+/g, " ").trim(), MAX_TASK_CHARS)
    : "";

  const stage1Model = details?.stage1?.model ?? "";
  const stage1bModel = details?.stage1b?.model ?? "";
  const stage1cModel = details?.stage1c?.model ?? "";
  const stage2Model = details?.stage2?.model ?? "";
  const scoutParts = [stage1Model, stage1bModel, stage1cModel].filter(Boolean);
  const scoutChain = scoutParts.length > 1 ? scoutParts.join("+") : stage1Model;
  const modelChain = [scoutChain, stage2Model].filter(Boolean).join("→");

  const costNum = (details?.stage1?.usage?.cost ?? 0) + (details?.stage1b?.usage?.cost ?? 0) + (details?.stage1c?.usage?.cost ?? 0) + (details?.stage2?.usage?.cost ?? 0);
  const costStr = fmtCost(costNum);
  const modeLabel = formatModeLabel(ui?.mode, details);
  const metrics = formatUiMetrics(ui);

  // Build lines
  const lines: string[] = [];

  const statusIcon = isErr ? "✗" : "✓";
  const statusLabel = isErr ? "failed" : "completed";
  const statusBgToken = isErr ? "toolErrorBg" : "toolSuccessBg";
  const statusText = `${statusIcon} ${statusLabel}  ${modelChain}  ${costStr}`.trimEnd();

  lines.push(bg(statusBgToken, fg(isErr ? "error" : "success", statusText), theme, themed));
  if (modeLabel || metrics) {
    lines.push(fg("dim", `  ${[modeLabel, metrics].filter(Boolean).join(" | ")}`));
  }

  if (opts.expanded) {
    if (taskText) lines.push(fg("dim", `  task: ${taskText}`));
    if (ui?.reportPath) lines.push(fg("dim", `  report: ${ui.reportPath}`));
    if (details?.stage1?.model) {
      const s1 = details.stage1;
      const dur1 = fmtDuration(s1.durationMs);
      const s1Text = `  Scout: ${s1.model} (exit ${s1.exitCode ?? "?"}${dur1 ? `, ${dur1}` : ""})`;
      lines.push(bg("toolStageBg", fg("dim", s1Text), theme, themed));
    }
    if (details?.stage1b?.model) {
      const s1b = details.stage1b;
      const dur1b = fmtDuration(s1b.durationMs);
      const s1bText = `  Scout B: ${s1b.model} (exit ${s1b.exitCode ?? "?"}${dur1b ? `, ${dur1b}` : ""})`;
      lines.push(bg("toolStageBg", fg("dim", s1bText), theme, themed));
    }
    if (details?.stage1c?.model) {
      const s1c = details.stage1c;
      const dur1c = fmtDuration(s1c.durationMs);
      const s1cText = `  Scout C: ${s1c.model} (exit ${s1c.exitCode ?? "?"}${dur1c ? `, ${dur1c}` : ""})`;
      lines.push(bg("toolStageBg", fg("dim", s1cText), theme, themed));
    }
    if (details?.stage1Backup?.model) {
      const sb = details.stage1Backup;
      const durB = fmtDuration(sb.durationMs);
      const sbText = `  Backup: ${sb.model} (exit ${sb.exitCode ?? "?"}${durB ? `, ${durB}` : ""})`;
      lines.push(bg("toolStageBg", fg("dim", sbText), theme, themed));
    }
    if (details?.stage2?.model) {
      const s2 = details.stage2;
      const dur2 = fmtDuration(s2.durationMs);
      const s2Text = `  Forge: ${s2.model} (exit ${s2.exitCode ?? "?"}${dur2 ? `, ${dur2}` : ""})`;
      lines.push(bg("toolStageBg", fg("dim", s2Text), theme, themed));
    }
    if (isErr && textOut) {
      for (const line of textOut.split("\n").slice(0, 4)) {
        lines.push(fg("error", `  ${trunc(line, MAX_PREVIEW_CHARS)}`));
      }
    } else if (textOut) {
      lines.push("");
      for (const line of textOut.split("\n").slice(0, 3)) {
        lines.push(fg("toolOutput", trunc(line, MAX_PREVIEW_CHARS)));
      }
    }
  } else {
    // collapsed: one-line preview
    if (textOut) {
      lines.push(fg("muted", trunc(textOut.split("\n")[0], MAX_PREVIEW_CHARS - 2)));
    }
    const hasMore = textOut && textOut.split("\n").length > 1;
    if (hasMore) {
      let hint = keyHint("expand");
      if (typeof hint !== "string") hint = "";
      const clean = hint.replace(/\s+/g, " ").trim();
      const isUseless = !clean || /\bundefined\b/i.test(clean) || /^[()[\]{}]*$/.test(clean);
      lines.push(`(${isUseless ? "expand" : clean})`);
    }
  }

  return new SimpleText(lines.join("\n")) as unknown as Component;
}

// ---------------------------------------------------------------------------
// minimal Component implementation — no external TUI dependencies
// ---------------------------------------------------------------------------

class SimpleText implements Component {
  [key: string]: unknown;
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(_width: number): string[] {
    return this.text.split("\n");
  }

  invalidate(): void {}
  dispose(): void {}
}

function formatModeLabel(mode: unknown, details: AutoForkDetails | undefined): string {
  if (typeof mode === "string" && mode) return mode;
  if (details?.research) return "research";
  if (details?.stage1 && !details?.stage2) return "quick";
  if (!details?.stage1 && details?.stage2) return details?.ui?.mode === "advisor" ? "advisor" : "review";
  if (details?.stage1 && details?.stage2) return details?.ui?.mode === "advisor" ? "advisor" : "fork";
  return "";
}

function formatScore(score: unknown): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return `${Math.round(score * 10)}/10`;
}

function formatUiMetrics(ui: AutoForkUiDetails | undefined): string {
  const parts: string[] = [];
  if (typeof ui?.status === "string") parts.push(ui.status);
  const quality = formatScore(ui?.qualityScore);
  if (quality) parts.push(`quality ${quality}`);
  const grounding = formatScore(ui?.groundingScore);
  if (grounding) parts.push(`grounding ${grounding}`);
  const coverage = ui?.coverage;
  if (coverage && typeof coverage === "object") {
    const cited = typeof coverage.filesCited === "number" ? coverage.filesCited : 0;
    const inspected = typeof coverage.filesInspected === "number" ? coverage.filesInspected : 0;
    const commands = typeof coverage.commandsRun === "number" ? coverage.commandsRun : 0;
    parts.push(`coverage ${cited}/${inspected} files, ${commands} cmds`);
  }
  if (typeof ui?.ungroundedClaimCount === "number" && ui.ungroundedClaimCount > 0) {
    parts.push(`${ui.ungroundedClaimCount} ungrounded`);
  }
  if (typeof ui?.actionItemCount === "number" && ui.actionItemCount > 0) {
    parts.push(`${ui.actionItemCount} action${ui.actionItemCount === 1 ? "" : "s"}`);
  }
  return parts.join(" | ");
}
