/**
 * Pi JSON mode event processing — parsing and accumulating fork results.
 */

import type { ForkResult } from "./types.js";
import { stableStringify } from "./stable-stringify.js";
import { sanitizeAssistantMessage, getFinalAssistantText, type AssistantMessage } from "./messages.js";
import { addNestedForkUsage } from "./usage.js";

// Internal bookkeeping properties attached to ForkResult instances.
declare module "./types.js" {
  interface ForkResult {
    __seenMessageSignatures?: Set<string>;
    __seenForkToolResultSignatures?: Set<string>;
    __activityOrder?: number;
  }
}

function getSeenMessageSignatures(result: ForkResult): Set<string> {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set<string>(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures as Set<string>;
}

function updateAssistantMetadata(result: ForkResult, message: AssistantMessage): void {
  if (!message || message.role !== "assistant") return;
  if (!result.provider && message.provider) result.provider = message.provider;
  if (!result.model && message.model) result.model = message.model;

  const isAssistantError = message.stopReason === "error" || message.stopReason === "aborted" || Boolean(message.errorMessage);
  if (message.stopReason) {
    if (!(result.retry?.success === false && !isAssistantError)) {
      result.stopReason = message.stopReason;
    }
  } else if (!isAssistantError && result.retry?.history?.length && result.retry?.success !== false) {
    delete result.stopReason;
  }

  if (message.errorMessage) {
    result.errorMessage = message.errorMessage;
  } else if (!isAssistantError && result.retry?.history?.length && result.retry?.success !== false) {
    delete result.errorMessage;
  }
}

function addAssistantMessage(result: ForkResult, message: AssistantMessage): boolean {
  if (!message || message.role !== "assistant") return false;

  const sanitizedMessage = sanitizeAssistantMessage(message);
  updateAssistantMetadata(result, sanitizedMessage);

  const signature = stableStringify(sanitizedMessage);
  const seen = getSeenMessageSignatures(result);
  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(sanitizedMessage as ForkResult["messages"][number]);

  result.usage.turns++;
  if (message.usage) {
    const usage = message.usage;
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += typeof usage.cost === "object" && usage.cost !== null
      ? (usage.cost as { total?: number }).total || 0
      : typeof usage.cost === "number" ? usage.cost : 0;
    result.usage.contextTokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) || 0;
  }

  return true;
}

type ProcessableMessage = AssistantMessage | { role?: unknown; toolName?: unknown; toolCallId?: unknown; details?: { results?: unknown } };

function addMessageUsage(result: ForkResult, message: ProcessableMessage): boolean {
  return addAssistantMessage(result, message as AssistantMessage) || addNestedForkUsage(result, message as { role?: unknown; toolName?: unknown; toolCallId?: unknown; details?: { results?: unknown } });
}

function addMessagesUsage(result: ForkResult, messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addMessageUsage(result, message as ProcessableMessage)) changed = true;
  }
  return changed;
}

function ensureRetryState(result: ForkResult): {
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

function processAutoRetryStart(
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

function processAutoRetryEnd(
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

interface ToolResult {
  content?: unknown;
  text?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function truncateTail(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `… truncated …\n${text.slice(text.length - maxChars)}`;
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

function extractResultText(toolResult: ToolResult | undefined): string {
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

function stringifyPreview(value: unknown, maxChars: number): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncateMiddle(value, maxChars);

  try {
    return truncateMiddle(JSON.stringify(value), maxChars);
  } catch {
    return "";
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 15);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}\n… truncated …\n${text.slice(text.length - tail)}`;
}

function shortPath(value: string): string {
  if (typeof value !== "string" || !value) return "...";
  return value.replace(/^\/home\/[^/]+/, "~");
}

function truncateInline(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

interface ToolArgs {
  command?: unknown;
  path?: unknown;
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
  pattern?: unknown;
  task?: unknown;
  [key: string]: unknown;
}

function formatToolCallPreview(toolName: string, args: ToolArgs): string {
  if (!args || typeof args !== "object") return toolName || "tool";

  switch (toolName) {
    case "bash": {
      const command = typeof args.command === "string" ? args.command : "...";
      return `bash $ ${truncateInline(command, 80)}`;
    }
    case "read": {
      const filePath = shortPath(String(args.path || args.file_path || ""));
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
      return `read ${filePath}${range}`;
    }
    case "write":
      return `write ${shortPath(String(args.path || args.file_path || ""))}`;
    case "edit":
      return `edit ${shortPath(String(args.path || args.file_path || ""))}`;
    case "ls":
      return `ls ${shortPath(String(args.path || "."))}`;
    case "find":
      return `find ${truncateInline(stringifyPreview(args.pattern || "*", 60), 60)} in ${shortPath(String(args.path || "."))}`;
    case "grep":
      return `grep ${truncateInline(stringifyPreview(args.pattern || "", 60), 60)} in ${shortPath(String(args.path || "."))}`;
    case "cdev": {
      const task = typeof args.task === "string" ? args.task : stringifyPreview(args, 80);
      return `cdev ${truncateInline(task, 80)}`;
    }
    default: {
      const argsPreview = truncateInline(stringifyPreview(args, 70), 70);
      return argsPreview ? `${toolName} ${argsPreview}` : toolName || "tool";
    }
  }
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

function addActivity(result: ForkResult, activity: ToolExecutionEntry): ToolExecutionEntry {
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

interface ToolExecutionEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: ToolResult;
  result?: ToolResult;
  isError?: boolean;
}

function findToolExecution(result: ForkResult, event: ToolExecutionEvent): ToolExecutionEntry {
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

function processToolExecutionEvent(event: ToolExecutionEvent, result: ForkResult): boolean {
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

interface AssistantMessageEvent {
  type: string;
  delta?: string;
  content?: string;
}

interface MessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent?: AssistantMessageEvent;
}

function latestActivity(result: ForkResult): ToolExecutionEntry | undefined {
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

function getThinkingChars(activity: ToolExecutionEntry): number {
  if (typeof activity?._thinkingChars === "number") return activity._thinkingChars;
  if (typeof activity?.chars === "number") return activity.chars;
  if (typeof activity?.tokens === "number") return activity.tokens * 4;
  return 0;
}

function setThinkingChars(activity: ToolExecutionEntry, chars: number): void {
  Object.defineProperty(activity, "_thinkingChars", {
    value: Math.max(0, chars),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  activity.tokens = estimateTokensFromChars(chars);
  delete activity.chars;
}

function createThinkingActivity(result: ForkResult): ToolExecutionEntry {
  const activity = addActivity(result, {
    type: "thinking",
    status: "running",
    tokens: 0,
    activityOrder: nextActivityOrder(result),
  });
  setThinkingChars(activity, 0);
  return activity;
}

function ensureLatestThinkingActivity(result: ForkResult): ToolExecutionEntry {
  return latestRunningThinkingActivity(result) || createThinkingActivity(result);
}

function getThinkingTokens(thinking: { tokens?: number; chars?: number }): number {
  if (typeof thinking?.tokens === "number") return thinking.tokens;
  if (typeof thinking?.chars === "number") return estimateTokensFromChars(thinking.chars);
  return 0;
}

function syncThinkingState(result: ForkResult, activity: { status?: string; _thinkingChars?: number; chars?: number; tokens?: number; activityOrder?: number }): { status?: string; tokens?: number; activityOrder?: number } {
  result.thinking = {
    status: activity.status,
    tokens: getThinkingTokens(activity),
    activityOrder: activity.activityOrder,
  };
  return result.thinking;
}

function processMessageUpdateEvent(event: MessageUpdateEvent, result: ForkResult): boolean {
  const assistantEvent = event.assistantMessageEvent;
  if (!assistantEvent || typeof assistantEvent !== "object") return false;

  switch (assistantEvent.type) {
    case "thinking_start": {
      const currentLatest = latestActivity(result);
      const activity = currentLatest?.type === "thinking" && currentLatest.status === "running"
        ? currentLatest
        : createThinkingActivity(result);
      activity.status = "running";
      syncThinkingState(result, activity);
      return true;
    }

    case "thinking_delta": {
      const activity = ensureLatestThinkingActivity(result);
      activity.status = "running";
      if (typeof assistantEvent.delta === "string") {
        setThinkingChars(activity, getThinkingChars(activity) + assistantEvent.delta.length);
      }
      syncThinkingState(result, activity);
      return true;
    }

    case "thinking_end": {
      const activity = ensureLatestThinkingActivity(result);
      activity.status = "completed";
      if (typeof assistantEvent.content === "string") {
        setThinkingChars(activity, assistantEvent.content.length);
      }
      syncThinkingState(result, activity);
      return true;
    }

    default:
      return false;
  }
}

export interface PiEvent {
  type: string;
  message?: ProcessableMessage;
  toolResults?: unknown;
  messages?: unknown;
  willRetry?: boolean;
  assistantMessageEvent?: AssistantMessageEvent;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: ToolResult;
  result?: ToolResult;
  isError?: boolean;
}

export function processPiEvent(event: PiEvent, result: ForkResult): boolean {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "message_update":
      return processMessageUpdateEvent(event as MessageUpdateEvent, result);

    case "message_end":
      return addMessageUsage(result, event.message as ProcessableMessage);

    case "turn_end": {
      let changed = false;
      if (addMessageUsage(result, event.message as ProcessableMessage)) changed = true;
      if (addMessagesUsage(result, event.toolResults)) changed = true;
      return changed;
    }

    case "agent_end":
      result.sawAgentEnd = true;
      if (typeof event.willRetry === "boolean") result.willRetry = event.willRetry;
      else delete result.willRetry;
      return addMessagesUsage(result, event.messages);

    case "auto_retry_start":
      return processAutoRetryStart(event as { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }, result);

    case "auto_retry_end":
      return processAutoRetryEnd(event as { type: "auto_retry_end"; attempt?: number; success?: boolean; finalError?: string }, result);

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return processToolExecutionEvent(event as ToolExecutionEvent, result);

    default:
      return false;
  }
}

export function processPiJsonLine(line: string, result: ForkResult): boolean {
  if (!line.trim()) return false;

  let event: PiEvent;
  try {
    event = JSON.parse(line) as PiEvent;
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

export { getFinalAssistantText };
