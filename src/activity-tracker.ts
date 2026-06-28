/**
 * Activity tracking for Pi JSON event processing.
 * Tracks tool executions, thinking state, retry state, and activity ordering.
 * Extracted from events.ts for testability.
 */

import type { ForkResult } from "./types.js";
import { truncateTail, formatToolCallPreview, stringifyPreview, type ToolArgs } from "./text-truncator.js";

// ── Tool result extraction ─────────────────────────────────

export interface ToolResult {
  content?: unknown;
  text?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typedPart = part as { type?: unknown; text?: unknown };
    if (typedPart.type === "text" && typeof typedPart.text === "string") {
      parts.push(typedPart.text);
    } else if (typedPart.type === "image") {
      parts.push("[image]");
    }
  }

  return parts.join("\n").trim();
}

export function extractResultText(toolResult: ToolResult | undefined): string {
  if (!toolResult || typeof toolResult !== "object") return "";

  const contentText = extractTextFromContent(toolResult.content);
  if (contentText) return truncateTail(contentText, 1200);

  if (typeof toolResult.text === "string") {
    return truncateTail(toolResult.text.trim(), 1200);
  }

  if (typeof toolResult.message === "string") {
    return truncateTail(toolResult.message.trim(), 1200);
  }

  return "";
}

// ── Activity / tool execution tracking ─────────────────────

export interface ToolExecutionEntry {
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

function maxActivityOrder(result: ForkResult): number {
  const orders: number[] = [];
  if (typeof result.thinking?.activityOrder === "number") orders.push(result.thinking.activityOrder);
  if (Array.isArray(result.activities)) {
    for (const activity of result.activities) {
      if (activity && typeof activity.activityOrder === "number") orders.push(activity.activityOrder);
    }
  }
  if (Array.isArray(result.toolExecutions)) {
    for (const tool of result.toolExecutions) {
      if (tool && typeof tool.activityOrder === "number") orders.push(tool.activityOrder);
    }
  }
  return orders.length > 0 ? Math.max(...orders) : 0;
}

function nextActivityOrder(result: ForkResult): number {
  if (!Object.prototype.hasOwnProperty.call(result, "__activityOrder")) {
    Object.defineProperty(result, "__activityOrder", {
      value: maxActivityOrder(result),
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  result.__activityOrder = (result.__activityOrder || 0) + 1;
  return result.__activityOrder;
}

function ensureActivities(result: ForkResult): ToolExecutionEntry[] {
  if (!Array.isArray(result.activities)) result.activities = [];
  return result.activities as ToolExecutionEntry[];
}

export function addActivity(result: ForkResult, activity: ToolExecutionEntry): ToolExecutionEntry {
  const activities = ensureActivities(result);
  const totalBefore = typeof result.activityCount === "number"
    ? result.activityCount
    : activities.length;
  result.activityCount = totalBefore + 1;
  activities.push(activity);
  return activity;
}

function findToolActivity(result: ForkResult, toolCallId: string | undefined): ToolExecutionEntry | undefined {
  if (!toolCallId || !Array.isArray(result.activities)) return undefined;
  return (result.activities as ToolExecutionEntry[]).find((activity) => activity?.toolCallId === toolCallId);
}

function syncToolActivity(result: ForkResult, tool: ToolExecutionEntry): ToolExecutionEntry | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  let activity = findToolActivity(result, tool.toolCallId);
  if (!activity) {
    activity = { ...tool, activityOrder: tool.activityOrder || nextActivityOrder(result) };
    addActivity(result, activity);
  } else {
    Object.assign(activity, tool, { type: "tool" });
  }
  return activity;
}

function ensureToolExecutions(result: ForkResult): ToolExecutionEntry[] {
  if (!Array.isArray(result.toolExecutions)) result.toolExecutions = [];
  return result.toolExecutions as ToolExecutionEntry[];
}

export interface ToolExecutionEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: ToolResult;
  result?: ToolResult;
  isError?: boolean;
}

export function findToolExecution(result: ForkResult, event: ToolExecutionEvent): ToolExecutionEntry {
  const toolExecutions = ensureToolExecutions(result);
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;

  let tool = toolCallId
    ? toolExecutions.find((entry) => entry.toolCallId === toolCallId)
    : undefined;

  if (!tool) {
    const totalBefore = typeof result.toolExecutionCount === "number"
      ? result.toolExecutionCount
      : toolExecutions.length;
    result.toolExecutionCount = totalBefore + 1;
    tool = {
      toolCallId: toolCallId || `unknown-${result.toolExecutionCount}`,
      toolName: typeof event.toolName === "string" ? event.toolName : "tool",
      status: "running",
      updates: 0,
      activityOrder: nextActivityOrder(result),
    };
    while (toolExecutions.length >= 25) {
      toolExecutions.shift();
    }
    toolExecutions.push(tool);
  }

  if (typeof event.toolName === "string") tool.toolName = event.toolName;
  if (Object.prototype.hasOwnProperty.call(event, "args")) {
    tool.argsPreview = stringifyPreview(event.args, 300);
    tool.displayText = formatToolCallPreview(tool.toolName || "tool", event.args as ToolArgs);
  }

  if (!tool.displayText) tool.displayText = tool.toolName;

  return tool;
}

export function processToolExecutionEvent(event: ToolExecutionEvent, result: ForkResult): boolean {
  const tool = findToolExecution(result, event);

  switch (event.type) {
    case "tool_execution_start":
      tool.status = "running";
      tool.isError = false;
      tool.latestText = "";
      syncToolActivity(result, tool);
      return true;

    case "tool_execution_update": {
      tool.status = "running";
      tool.isError = false;
      tool.updates = (tool.updates || 0) + 1;
      const latestText = extractResultText(event.partialResult);
      if (latestText) tool.latestText = latestText;
      syncToolActivity(result, tool);
      return true;
    }

    case "tool_execution_end": {
      tool.status = event.isError ? "error" : "completed";
      tool.isError = Boolean(event.isError);
      const latestText = extractResultText(event.result);
      if (latestText) tool.latestText = latestText;
      syncToolActivity(result, tool);
      return true;
    }

    default:
      return false;
  }
}

// ── Thinking state tracking ────────────────────────────────

export function latestActivity(result: ForkResult): ToolExecutionEntry | undefined {
  const activities = Array.isArray(result.activities) ? (result.activities as ToolExecutionEntry[]) : [];
  return activities[activities.length - 1];
}

function latestRunningThinkingActivity(result: ForkResult): ToolExecutionEntry | undefined {
  const activities = Array.isArray(result.activities) ? (result.activities as ToolExecutionEntry[]) : [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "thinking" && activity.status === "running") return activity;
  }
  return undefined;
}

function estimateTokensFromChars(chars: number): number {
  const safeChars = typeof chars === "number" && Number.isFinite(chars) && chars > 0 ? chars : 0;
  return safeChars > 0 ? Math.ceil(safeChars / 4) : 0;
}

export function getThinkingChars(activity: ToolExecutionEntry): number {
  if (typeof activity?._thinkingChars === "number") return activity._thinkingChars;
  if (typeof activity?.chars === "number") return activity.chars;
  if (typeof activity?.tokens === "number") return activity.tokens * 4;
  return 0;
}

export function setThinkingChars(activity: ToolExecutionEntry, chars: number): void {
  Object.defineProperty(activity, "_thinkingChars", {
    value: Math.max(0, chars),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  activity.tokens = estimateTokensFromChars(chars);
  delete activity.chars;
}

export function createThinkingActivity(result: ForkResult): ToolExecutionEntry {
  const activity = addActivity(result, {
    type: "thinking",
    status: "running",
    tokens: 0,
    activityOrder: nextActivityOrder(result),
  });
  setThinkingChars(activity, 0);
  return activity;
}

export function ensureLatestThinkingActivity(result: ForkResult): ToolExecutionEntry {
  return latestRunningThinkingActivity(result) || createThinkingActivity(result);
}

function getThinkingTokens(thinking: { tokens?: number; chars?: number }): number {
  if (typeof thinking?.tokens === "number") return thinking.tokens;
  if (typeof thinking?.chars === "number") return estimateTokensFromChars(thinking.chars);
  return 0;
}

export function syncThinkingState(result: ForkResult, activity: { status?: string; _thinkingChars?: number; chars?: number; tokens?: number; activityOrder?: number }): { status?: string; tokens?: number; activityOrder?: number } {
  result.thinking = {
    status: activity.status,
    tokens: getThinkingTokens(activity),
    activityOrder: activity.activityOrder,
  };
  return result.thinking;
}

// ── Auto-retry state tracking ──────────────────────────────

export function ensureRetryState(result: ForkResult): {
  active?: boolean;
  pending?: boolean;
  success?: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  finalError?: string;
  history?: { type: "start" | "end"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string; success?: boolean; finalError?: string }[];
} {
  if (!result.retry || typeof result.retry !== "object") result.retry = {};
  if (!Array.isArray(result.retry.history)) result.retry.history = [];
  return result.retry as {
    active?: boolean;
    pending?: boolean;
    success?: boolean;
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    errorMessage?: string;
    finalError?: string;
    history?: { type: "start" | "end"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string; success?: boolean; finalError?: string }[];
  };
}

export function processAutoRetryStart(
  event: { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string },
  result: ForkResult,
): boolean {
  const retry = ensureRetryState(result);
  retry.active = true;
  retry.pending = false;
  retry.success = undefined;

  if (typeof event.attempt === "number") retry.attempt = event.attempt;
  if (typeof event.maxAttempts === "number") retry.maxAttempts = event.maxAttempts;
  if (typeof event.delayMs === "number") retry.delayMs = event.delayMs;
  if (typeof event.errorMessage === "string") retry.errorMessage = event.errorMessage;
  delete retry.finalError;

  retry.history!.push({
    type: "start",
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    delayMs: retry.delayMs,
    errorMessage: retry.errorMessage,
  });

  result.sawAgentEnd = false;
  return true;
}

export function processAutoRetryEnd(
  event: { type: "auto_retry_end"; attempt?: number; success?: boolean; finalError?: string },
  result: ForkResult,
): boolean {
  const retry = ensureRetryState(result);
  retry.active = false;
  retry.pending = false;
  retry.success = Boolean(event.success);

  if (typeof event.attempt === "number") retry.attempt = event.attempt;
  if (typeof event.finalError === "string") retry.finalError = event.finalError;

  retry.history!.push({
    type: "end",
    attempt: retry.attempt,
    success: retry.success,
    finalError: retry.finalError,
  });

  if (!retry.success) {
    result.stopReason = "error";
    if (retry.finalError) result.errorMessage = retry.finalError;
  }

  return true;
}
