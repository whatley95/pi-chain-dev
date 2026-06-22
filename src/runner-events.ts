/**
 * Helpers for parsing Pi JSON mode events and summarizing fork results.
 */

import type { ForkResult, UsageStats } from "./types.js";

const MAX_TOOL_PREVIEW_CHARS = 1200;
const MAX_TOOL_ARGS_PREVIEW_CHARS = 300;
const MAX_INLINE_ERROR_PREVIEW_CHARS = 160;
const MAX_STORED_TOOL_EXECUTIONS = 25;

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

function getSeenForkToolResultSignatures(result: ForkResult): Set<string> {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenForkToolResultSignatures")) {
    Object.defineProperty(result, "__seenForkToolResultSignatures", {
      value: new Set<string>(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenForkToolResultSignatures as Set<string>;
}

export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const objValue = value as object;
  if (seen.has(objValue)) {
    return '"<circular>"';
  }
  seen.add(objValue);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`)
    .join(",")}}`;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 15);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}\n… truncated …\n${text.slice(text.length - tail)}`;
}

function truncateTail(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `… truncated …\n${text.slice(text.length - maxChars)}`;
}

function truncateInline(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
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

function shortPath(value: string): string {
  if (typeof value !== "string" || !value) return "...";
  return value.replace(/^\/home\/[^/]+/, "~");
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
    case "fork": {
      const task = typeof args.task === "string" ? args.task : stringifyPreview(args, 80);
      return `fork ${truncateInline(task, 80)}`;
    }
    default: {
      const argsPreview = truncateInline(stringifyPreview(args, 70), 70);
      return argsPreview ? `${toolName} ${argsPreview}` : toolName || "tool";
    }
  }
}

interface ContentPart {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  [key: string]: unknown;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typedPart = part as ContentPart;
    if (typedPart.type === "text" && typeof typedPart.text === "string") {
      parts.push(typedPart.text);
    } else if (typedPart.type === "image") {
      parts.push("[image]");
    }
  }

  return parts.join("\n").trim();
}

interface ToolResult {
  content?: unknown;
  text?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

function extractResultText(toolResult: ToolResult | undefined): string {
  if (!toolResult || typeof toolResult !== "object") return "";

  const contentText = extractTextFromContent(toolResult.content);
  if (contentText) return truncateTail(contentText, MAX_TOOL_PREVIEW_CHARS);

  if (typeof toolResult.text === "string") {
    return truncateTail(toolResult.text.trim(), MAX_TOOL_PREVIEW_CHARS);
  }

  if (typeof toolResult.message === "string") {
    return truncateTail(toolResult.message.trim(), MAX_TOOL_PREVIEW_CHARS);
  }

  return "";
}

interface AssistantMessage {
  role?: unknown;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Partial<UsageStats> & {
    cost?: { total?: number } | number;
    totalTokens?: number;
  };
  content?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
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

function sanitizeAssistantMessage(message: AssistantMessage): AssistantMessage {
  const sanitized: AssistantMessage = { ...message };
  delete sanitized.thinking;
  delete sanitized.reasoning;
  delete sanitized.reasoning_content;

  if (Array.isArray(message.content)) {
    sanitized.content = message.content
      .filter((part: unknown) => {
        if (!part || typeof part !== "object") return true;
        return (part as ContentPart).type !== "thinking";
      })
      .map((part: unknown) => {
        if (!part || typeof part !== "object") return part;
        const cleanPart: ContentPart = { ...(part as ContentPart) };
        delete cleanPart.thinking;
        delete cleanPart.reasoning;
        delete cleanPart.reasoning_content;
        return cleanPart;
      });
  }

  return sanitized;
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
  const usage = message.usage;
  if (usage) {
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

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ToolResultMessage {
  role?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  details?: { results?: unknown };
}

function addNestedForkUsage(result: ForkResult, message: ToolResultMessage): boolean {
  if (!message || message.role !== "toolResult" || message.toolName !== "fork") return false;

  const results = message.details?.results;
  if (!Array.isArray(results)) return false;

  const signature = typeof message.toolCallId === "string" && message.toolCallId
    ? `toolCallId:${message.toolCallId}`
    : stableStringify({ toolName: message.toolName, details: message.details });
  const seen = getSeenForkToolResultSignatures(result);
  if (seen.has(signature)) return false;

  let changed = false;
  for (const forkResult of results) {
    const usage = (forkResult as { usage?: Partial<UsageStats> & { cost?: { total?: number } | number; totalTokens?: number } }).usage;
    if (!usage || typeof usage !== "object") continue;

    const input = finiteNumber(usage.input);
    const output = finiteNumber(usage.output);
    const cacheRead = finiteNumber(usage.cacheRead);
    const cacheWrite = finiteNumber(usage.cacheWrite);
    const cost = typeof usage.cost === "object" && usage.cost !== null
      ? finiteNumber((usage.cost as { total?: number }).total)
      : finiteNumber(usage.cost);
    const turns = finiteNumber(usage.turns);
    const contextTokens = finiteNumber(usage.contextTokens) || finiteNumber(usage.totalTokens);

    if (!(input || output || cacheRead || cacheWrite || cost || turns || contextTokens)) continue;

    result.usage.input += input;
    result.usage.output += output;
    result.usage.cacheRead += cacheRead;
    result.usage.cacheWrite += cacheWrite;
    result.usage.cost += cost;
    result.usage.turns += turns;
    result.usage.contextTokens = Math.max(result.usage.contextTokens || 0, contextTokens);
    changed = true;
  }

  if (changed) seen.add(signature);
  return changed;
}

type ProcessableMessage = AssistantMessage | ToolResultMessage;

function addMessageUsage(result: ForkResult, message: ProcessableMessage): boolean {
  return addAssistantMessage(result, message as AssistantMessage) || addNestedForkUsage(result, message as ToolResultMessage);
}

function addMessagesUsage(result: ForkResult, messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addMessageUsage(result, message as ProcessableMessage)) changed = true;
  }
  return changed;
}

function ensureRetryState(result: ForkResult): RetryState {
  if (!result.retry || typeof result.retry !== "object") result.retry = {};
  if (!Array.isArray(result.retry.history)) result.retry.history = [];
  return result.retry as RetryState;
}

interface AutoRetryStartEvent {
  type: "auto_retry_start";
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
}

function processAutoRetryStart(event: AutoRetryStartEvent, result: ForkResult): boolean {
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

interface AutoRetryEndEvent {
  type: "auto_retry_end";
  attempt?: number;
  success?: boolean;
  finalError?: string;
}

function processAutoRetryEnd(event: AutoRetryEndEvent, result: ForkResult): boolean {
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

function ensureActivities(result: ForkResult): Activity[] {
  if (!Array.isArray(result.activities)) result.activities = [];
  return result.activities as Activity[];
}

function addActivity(result: ForkResult, activity: Activity): Activity {
  const activities = ensureActivities(result);
  const totalBefore = typeof result.activityCount === "number"
    ? result.activityCount
    : activities.length;
  result.activityCount = totalBefore + 1;
  activities.push(activity);
  return activity;
}

function findToolActivity(result: ForkResult, toolCallId: string | undefined): Activity | undefined {
  if (!toolCallId || !Array.isArray(result.activities)) return undefined;
  return (result.activities as Activity[]).find((activity) => activity?.type === "tool" && activity.toolCallId === toolCallId);
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

function syncToolActivity(result: ForkResult, tool: ToolExecutionEntry): Activity | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  let activity = findToolActivity(result, tool.toolCallId);
  if (!activity) {
    activity = { type: "tool", ...tool, activityOrder: tool.activityOrder || nextActivityOrder(result) };
    addActivity(result, activity);
  } else {
    Object.assign(activity, tool, { type: "tool" });
  }
  return activity;
}

function latestActivity(result: ForkResult): Activity | undefined {
  const activities = Array.isArray(result.activities) ? (result.activities as Activity[]) : [];
  return activities[activities.length - 1];
}

function latestRunningThinkingActivity(result: ForkResult): Activity | undefined {
  const activities = Array.isArray(result.activities) ? (result.activities as Activity[]) : [];
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

function getThinkingChars(activity: Activity): number {
  if (typeof activity?._thinkingChars === "number") return activity._thinkingChars;
  if (typeof activity?.chars === "number") return activity.chars;
  if (typeof activity?.tokens === "number") return activity.tokens * 4;
  return 0;
}

function setThinkingChars(activity: Activity, chars: number): void {
  Object.defineProperty(activity, "_thinkingChars", {
    value: Math.max(0, chars),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  activity.tokens = estimateTokensFromChars(chars);
  delete activity.chars;
}

interface ThinkingState {
  tokens?: number;
  chars?: number;
}

function getThinkingTokens(thinking: ThinkingState): number {
  if (typeof thinking?.tokens === "number") return thinking.tokens;
  if (typeof thinking?.chars === "number") return estimateTokensFromChars(thinking.chars);
  return 0;
}

function createThinkingActivity(result: ForkResult): Activity {
  const activity = addActivity(result, {
    type: "thinking",
    status: "running",
    tokens: 0,
    activityOrder: nextActivityOrder(result),
  });
  setThinkingChars(activity, 0);
  return activity;
}

function ensureLatestThinkingActivity(result: ForkResult): Activity {
  return latestRunningThinkingActivity(result) || createThinkingActivity(result);
}

function syncThinkingState(result: ForkResult, activity: Activity): ThinkingState {
  result.thinking = {
    status: activity.status,
    tokens: getThinkingTokens(activity),
    activityOrder: activity.activityOrder,
  };
  return result.thinking;
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
    while (toolExecutions.length >= MAX_STORED_TOOL_EXECUTIONS) {
      toolExecutions.shift();
    }
    toolExecutions.push(tool);
  }

  if (typeof event.toolName === "string") tool.toolName = event.toolName;
  if (Object.prototype.hasOwnProperty.call(event, "args")) {
    tool.argsPreview = stringifyPreview(event.args, MAX_TOOL_ARGS_PREVIEW_CHARS);
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
      return processAutoRetryStart(event as AutoRetryStartEvent, result);

    case "auto_retry_end":
      return processAutoRetryEnd(event as AutoRetryEndEvent, result);

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

export function getFinalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as AssistantMessage;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      const typedPart = part as ContentPart;
      if (typedPart?.type === "text" && typeof typedPart.text === "string" && typedPart.text.length > 0) {
        return typedPart.text;
      }
    }
  }

  return "";
}

/*
function getLatestRelevantToolExecution(result: ForkResult): ToolExecutionEntry | undefined {
  const activities = Array.isArray(result.activities) ? (result.activities as Activity[]) : [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool" && activity.status === "running") return activity;
  }
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool") return activity;
  }

  const toolExecutions = Array.isArray(result.toolExecutions) ? (result.toolExecutions as ToolExecutionEntry[]) : [];
  for (let i = toolExecutions.length - 1; i >= 0; i--) {
    if (toolExecutions[i]?.status === "running") return toolExecutions[i];
  }

  return toolExecutions[toolExecutions.length - 1];
}
*/

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
