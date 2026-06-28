/**
 * Pi JSON mode event processing — parsing and accumulating fork results.
 * Message handling and event dispatch. Activity tracking is in activity-tracker.ts.
 */

import type { ForkResult } from "./types.js";
import { stableStringify } from "./stable-stringify.js";
import { sanitizeAssistantMessage, getFinalAssistantText, type AssistantMessage } from "./messages.js";
import { addNestedForkUsage } from "./usage.js";
import {
  processToolExecutionEvent,
  processAutoRetryStart,
  processAutoRetryEnd,
  createThinkingActivity,
  ensureLatestThinkingActivity,
  syncThinkingState,
  latestActivity,
  getThinkingChars,
  setThinkingChars,
  type ToolResult,
  type ToolExecutionEvent,
} from "./activity-tracker.js";

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

// ── Thinking / message update events ──────────────────────

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

// ── Main event processing ─────────────────────────────────

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

export function processPiJsonLine(line: string, result: ForkResult): { handled: boolean; event: PiEvent | null } {
  if (!line.trim()) return { handled: false, event: null };

  let event: PiEvent;
  try {
    event = JSON.parse(line) as PiEvent;
  } catch {
    // Log malformed line to stderr instead of silently dropping the event stream
    const preview = line.length > 120 ? line.slice(0, 120) + "…" : line;
    result.stderr += `[cdev] malformed JSON line (dropped): ${preview}\n`;
    return { handled: false, event: null };
  }

  return { handled: processPiEvent(event, result), event };
}

export { getFinalAssistantText };
