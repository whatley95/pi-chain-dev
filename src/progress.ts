/**
 * Activity and progress formatting for fork runs.
 */

import { formatCost } from "./extension-context.js";
import { getFinalAssistantText } from "./messages.js";
import type { ForkResult } from "./types.js";

const MAX_INLINE_ERROR_PREVIEW_CHARS = 160;

interface Activity {
  type?: "thinking" | "tool" | string;
  status?: string;
  activityOrder?: number;
  displayText?: string;
  toolName?: string;
  toolCallId?: string;
  latestText?: string;
  isError?: boolean;
  _thinkingChars?: number;
  chars?: number;
  tokens?: number;
  [key: string]: unknown;
}

interface ToolExecutionEntry {
  toolCallId?: string;
  toolName?: string;
  status?: string;
  isError?: boolean;
  latestText?: string;
  argsPreview?: string;
  displayText?: string;
  updates?: number;
  activityOrder?: number;
  [key: string]: unknown;
}

interface ThinkingState {
  tokens?: number;
  chars?: number;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function truncateInline(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function estimateTokensFromChars(chars: number): number {
  const safeChars = typeof chars === "number" && Number.isFinite(chars) && chars > 0 ? chars : 0;
  return safeChars > 0 ? Math.ceil(safeChars / 4) : 0;
}

function getThinkingTokens(thinking: ThinkingState): number {
  if (typeof thinking?.tokens === "number") return thinking.tokens;
  if (typeof thinking?.chars === "number") return estimateTokensFromChars(thinking.chars);
  return 0;
}

function formatToolStatusIcon(tool: ToolExecutionEntry): string {
  if (tool?.status === "running") return "…";
  if (tool?.status === "error") return "×";
  return "✓";
}

function formatToolErrorSuffix(tool: ToolExecutionEntry): string {
  if (tool?.status !== "error" && !tool?.isError) return "";
  if (typeof tool.latestText !== "string" || !tool.latestText.trim()) return "";
  return ` — ${truncateInline(tool.latestText, MAX_INLINE_ERROR_PREVIEW_CHARS)}`;
}

function formatThinkingActivityProgress(thinking: ThinkingState & { status?: string }): string {
  if (!thinking || typeof thinking !== "object") return "";
  const icon = thinking.status === "running" ? "…" : "✓";
  const tokens = getThinkingTokens(thinking);
  const label = tokens > 0
    ? `thinking ~${formatCount(tokens)} tokens`
    : thinking.status === "running" ? "thinking..." : "thinking";
  return `${icon} ${label}`;
}

function getActivityOrder(item: Activity, fallback: number): number {
  return typeof item?.activityOrder === "number" ? item.activityOrder : fallback;
}

function formatActivityProgress(activity: Activity): string {
  if (activity?.type === "thinking") return formatThinkingActivityProgress(activity);
  if (activity?.type === "tool") {
    return `${formatToolStatusIcon(activity)} ${activity.displayText || activity.toolName || "tool"}${formatToolErrorSuffix(activity)}`;
  }
  return "";
}

function legacyActivities(result: ForkResult): Activity[] {
  const activities: Activity[] = [];
  if (result?.thinking) activities.push({ ...result.thinking, type: "thinking" });
  const toolExecutions = Array.isArray(result?.toolExecutions) ? (result.toolExecutions as ToolExecutionEntry[]) : [];
  for (const tool of toolExecutions) activities.push({ ...tool, type: "tool" });
  activities.sort((a, b) => getActivityOrder(a, 0) - getActivityOrder(b, 0));
  return activities;
}

function getStoredActivities(result: ForkResult): Activity[] {
  const activities = Array.isArray(result?.activities) && result.activities.length > 0
    ? (result.activities as Activity[])
    : legacyActivities(result);
  return activities.filter((activity) => activity && typeof activity === "object");
}

function totalActivities(result: ForkResult, storedActivities: Activity[]): number {
  if (typeof result?.activityCount === "number") {
    return Math.max(result.activityCount, storedActivities.length);
  }
  if (Array.isArray(result?.activities) && result.activities.length > 0) return storedActivities.length;
  const totalTools = typeof result?.toolExecutionCount === "number"
    ? Math.max(result.toolExecutionCount, Array.isArray(result?.toolExecutions) ? result.toolExecutions.length : 0)
    : Array.isArray(result?.toolExecutions) ? result.toolExecutions.length : 0;
  return totalTools + (result?.thinking ? 1 : 0);
}

interface RetryState {
  active?: boolean;
  pending?: boolean;
  success?: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  finalError?: string;
  history?: RetryHistoryEntry[];
}

interface RetryHistoryEntry {
  type: "start" | "end";
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
}

function formatRetryProgress(retry: RetryState): string {
  if (!retry || typeof retry !== "object" || !retry.active) return "";

  const attempt = typeof retry.attempt === "number" ? retry.attempt : undefined;
  const maxAttempts = typeof retry.maxAttempts === "number" ? retry.maxAttempts : undefined;
  const attemptText = attempt && maxAttempts
    ? `attempt ${attempt}/${maxAttempts}`
    : attempt ? `attempt ${attempt}` : "retrying";
  const delayText = typeof retry.delayMs === "number" && retry.delayMs > 0
    ? `, waiting ${Math.round(retry.delayMs / 1000)}s`
    : "";
  const errorText = typeof retry.errorMessage === "string" && retry.errorMessage.trim()
    ? ` after ${truncateInline(retry.errorMessage.trim(), MAX_INLINE_ERROR_PREVIEW_CHARS)}`
    : "";

  return `Retrying${errorText} (${attemptText}${delayText})`;
}

function formatToolProgress(result: ForkResult): string {
  const storedActivities = getStoredActivities(result);
  const lines: string[] = [];

  const toShow = storedActivities.slice(-10);
  const skipped = Math.max(0, totalActivities(result, storedActivities) - toShow.length);
  if (skipped > 0) lines.push(`... ${skipped} earlier activit${skipped === 1 ? "y" : "ies"}`);

  for (const activity of toShow) {
    const line = formatActivityProgress(activity);
    if (line) lines.push(line);
  }

  return lines.join("\n").trim();
}

export function getForkProgressText(result: ForkResult): string {
  const retryProgress = formatRetryProgress(result?.retry as RetryState);
  if (retryProgress) return retryProgress;

  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  const toolProgress = formatToolProgress(result);
  if (toolProgress) return toolProgress;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  return "(running...)";
}

export function getResultSummaryText(result: ForkResult): string {
  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}

export function summarizePiEvent(event: { type: string; [key: string]: unknown }): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  switch (event.type) {
    case "thinking": {
      const status = (event.status as string) || "";
      return status ? `thinking: ${status}` : "thinking";
    }
    case "activity": {
      const label = (event.label as string) || (event.type as string) || "";
      const status = (event.status as string) || "";
      if (label && status) return `${label}: ${status}`;
      return label || undefined;
    }
    case "toolExecution": {
      const toolName = (event.toolName as string) || "";
      const status = (event.status as string) || "";
      if (toolName) return `${toolName}: ${status || "running"}`;
      return undefined;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const toolName = (event.toolName as string) || "";
      const status = (event.status as string) || "";
      if (toolName) return `${toolName}: ${status || "running"}`;
      return undefined;
    }
    case "message": {
      const msg = event.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role === "assistant") return "assistant responded";
      if (msg?.role === "toolResult") return "tool result received";
      return undefined;
    }
    case "message_update": {
      const msg = event.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role === "assistant") return "assistant responding...";
      return undefined;
    }
    case "usage": {
      const cost = (event.cost as number) ?? undefined;
      const tokens = (event.totalTokens as number) ?? (event.tokens as number) ?? undefined;
      if (cost !== undefined || tokens !== undefined) {
        const parts: string[] = [];
        if (tokens !== undefined) parts.push(`${tokens} tokens`);
        if (cost !== undefined) parts.push(formatCost(cost));
        return `usage: ${parts.join(", ")}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}


/**
 * Update the cdev-progress widget with activity text, cost, and token count.
 */
export function updateProgress(
  setWidget: (key: string, value: unknown) => void,
  themedBg: (token: string, text: string) => string,
  update: { activity?: string; cost?: number; tokens?: number },
  prefix: string,
): void {
  const parts = [update.activity ?? ""];
  if (update.cost && update.cost > 0) parts.push(`● ${formatCost(update.cost)}`);
  if (update.tokens && update.tokens > 0) parts.push(`● ${formatCount(update.tokens)} tok`);
  setWidget("cdev-progress", [themedBg("toolPendingBg", `${prefix}  ${parts.filter(Boolean).join("  ")}`)]);
}
