/**
 * Text truncation and preview utilities for pi JSON event processing.
 * Extracted from events.ts for testability.
 */

export function truncateTail(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `… truncated …\n${text.slice(text.length - maxChars)}`;
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 15);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}\n… truncated …\n${text.slice(text.length - tail)}`;
}

export function truncateInline(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function stringifyPreview(value: unknown, maxChars: number): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncateMiddle(value, maxChars);

  try {
    return truncateMiddle(JSON.stringify(value), maxChars);
  } catch {
    return "";
  }
}

export function shortPath(value: string): string {
  if (typeof value !== "string" || !value) return "...";
  return value.replace(/^\/home\/[^/]+/, "~");
}

export interface ToolArgs {
  command?: unknown;
  path?: unknown;
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
  pattern?: unknown;
  task?: unknown;
  [key: string]: unknown;
}

export function formatToolCallPreview(toolName: string, args: ToolArgs): string {
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
