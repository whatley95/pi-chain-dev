/**
 * Message content / assistant message helpers used by event processing and formatting.
 */

import type { UsageStats } from "./types.js";

export interface ContentPart {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  [key: string]: unknown;
}

export interface AssistantMessage {
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

export function extractTextFromContent(content: unknown): string {
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

export function sanitizeAssistantMessage(message: AssistantMessage): AssistantMessage {
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
