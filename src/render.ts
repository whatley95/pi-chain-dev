/**
 * TUI renderers for the cdev tool.
 *
 * pi-chain-dev embeds custom renderCall / renderResult so the activity panel
 * shows the fork's progress and outcome instead of generic JSON.
 */

import type { Component, Theme } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";

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

// ---------------------------------------------------------------------------
// renderCall
// ---------------------------------------------------------------------------

export function renderCall(args: any, theme: Theme, _context?: any): Component {
  const fg = theme.fg.bind(theme);
  const task = typeof args?.task === "string" && args.task.trim()
    ? trunc(args.task.replace(/\s+/g, " ").trim(), MAX_TASK_CHARS)
    : "";

  let label: string;
  if (typeof args?.recall === "string" && args.recall !== undefined) {
    label = args.recall ? `cdev-recall "${args.recall}"` : "cdev-recall (list)";
  } else if (args?.review) {
    label = "cdev-review";
  } else if (args?.quick) {
    label = task ? `cdev-quick "${task}"` : "cdev-quick";
  } else {
    label = task ? `cdev "${task}"` : "cdev";
  }

  return new SimpleText(fg("toolTitle", label));
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

  const statusIcon = isErr ? fg("error", "✗") : fg("success", "✓");
  const statusLabel = isErr ? "failed" : "completed";

  lines.push(`${statusIcon} ${fg("toolTitle", statusLabel)}  ${fg("dim", modelChain)}  ${costStr}`.trimEnd());

  if (opts.expanded) {
    if (taskText) lines.push(fg("dim", `  task: ${taskText}`));
    if (details?.stage1?.model) {
      const s1 = details.stage1;
      lines.push(fg("dim", `  Scout: ${s1.model} (exit ${s1.exitCode ?? "?"})`));
    }
    if (details?.stage2?.model) {
      const s2 = details.stage2;
      lines.push(fg("dim", `  Forge: ${s2.model} (exit ${s2.exitCode ?? "?"})`));
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
