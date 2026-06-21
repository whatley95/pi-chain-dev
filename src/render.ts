/**
 * TUI renderers for the cdev tool.
 *
 * pi-chain-dev embeds custom renderCall / renderResult so the activity panel
 * shows the fork's progress and outcome instead of generic JSON.
 */

import type { Component, Theme } from "@earendil-works/pi-tui";
import { keyHint, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  return `$${cost.toFixed(4)}`;
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  } catch { return null; }
}

function isThemed(cwd?: string): boolean {
  if (!cwd) return false;
  try {
    // Project-local settings (overrides global)
    const proj = readJsonSafe(join(cwd, ".pi", "settings.json"));
    const projCdev = (proj?.["pi-chain-dev"] ?? proj?.["pi-auto-fork"]) as Record<string, unknown> | undefined;
    // Global agent settings (fallback)
    const global = readJsonSafe(join(getAgentDir(), "settings.json"));
    const globalCdev = global?.["pi-chain-dev"] as Record<string, unknown> | undefined;
    // Project overrides global, default false
    return (projCdev?.["themed"] ?? globalCdev?.["themed"]) === true;
  } catch {
    return false;
  }
}

/** Wrap text in theme background if themed mode is on. Falls back to ANSI if token missing. */
function bg(token: string, text: string, theme: Theme, themed: boolean): string {
  if (!themed) return text;
  try {
    const result = theme.bg(token, text);
    // theme.bg may return the text unchanged if token doesn't exist — check
    if (result !== text) return result;
  } catch {}
  // ANSI fallback
  const ansiColors: Record<string, string> = {
    toolPendingBg: "\x1b[43m", // yellow bg
    toolSuccessBg: "\x1b[42m", // green bg
    toolErrorBg: "\x1b[41m",   // red bg
    toolStageBg: "\x1b[100m",  // dark gray bg
  };
  const ansi = ansiColors[token];
  return ansi ? `${ansi} ${text} \x1b[0m` : text;
}

// ---------------------------------------------------------------------------
// renderCall
// ---------------------------------------------------------------------------

export function renderCall(args: any, theme: Theme, _context?: any): Component {
  const fg = theme.fg.bind(theme);
  const themed = isThemed(_context?.cwd);
  const task = typeof args?.task === "string" && args.task.trim()
    ? trunc(args.task.replace(/\s+/g, " ").trim(), MAX_TASK_CHARS)
    : "";

  let label: string;
  if (typeof args?.recall === "string") {
    label = args.recall ? `cdev-recall "${args.recall}"` : "cdev-recall (list)";
  } else if (args?.review) {
    label = "cdev-review";
  } else if (args?.quick) {
    label = task ? `cdev-quick "${task}"` : "cdev-quick";
  } else {
    label = task ? `cdev "${task}"` : "cdev";
  }

  return new SimpleText(bg("toolPendingBg", fg("toolTitle", label), theme, themed));
}

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

export function renderResult(
  toolResult: any,
  opts: { expanded: boolean },
  theme: Theme,
  _context?: any,
): Component {
  const fg = theme.fg.bind(theme);
  const themed = isThemed(_context?.cwd);
  const result = toolResult;
  const isErr = Boolean(result?.isError);
  const content = result?.content;
  const details = result?.details;
  const textOut = Array.isArray(content)
    ? content.map((p: any) => p?.text ?? "").join("\n").trim()
    : "";

  const taskText = details?.task
    ? trunc(String(details.task).replace(/\s+/g, " ").trim(), MAX_TASK_CHARS)
    : "";

  const stage1Model = details?.stage1?.model ?? "";
  const stage2Model = details?.stage2?.model ?? "";
  const modelChain = [stage1Model, stage2Model].filter(Boolean).join("→");

  const costNum = typeof details?.cost === "number" ? details.cost : 0;
  const costStr = fmtCost(costNum);

  // Build lines
  const lines: string[] = [];

  const statusIcon = isErr ? "✗" : "✓";
  const statusLabel = isErr ? "failed" : "completed";
  const statusBgToken = isErr ? "toolErrorBg" : "toolSuccessBg";
  const statusText = `${statusIcon} ${statusLabel}  ${modelChain}  ${costStr}`.trimEnd();

  lines.push(bg(statusBgToken, fg(isErr ? "error" : "success", statusText), theme, themed));

  if (opts.expanded) {
    if (taskText) lines.push(fg("dim", `  task: ${taskText}`));
    if (details?.stage1?.model) {
      const s1 = details.stage1;
      const s1Text = `  Scout: ${s1.model} (exit ${s1.exitCode ?? "?"})`;
      lines.push(bg("toolStageBg", fg("dim", s1Text), theme, themed));
    }
    if (details?.stage2?.model) {
      const s2 = details.stage2;
      const s2Text = `  Forge: ${s2.model} (exit ${s2.exitCode ?? "?"})`;
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
    if (hasMore) lines.push(`(${keyHint("app.tools.expand", "expand")})`);
  }

  return new SimpleText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// minimal Component implementation — no external TUI dependencies
// ---------------------------------------------------------------------------

class SimpleText implements Component {
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
