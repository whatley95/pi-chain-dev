/**
 * Loop detection for cdev.
 *
 * Detects repetitive tool-call patterns in the parent session (e.g. re-reading
 * the same report file) and returns a steer message the extension can inject
 * to break the agent out of the loop.
 */

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
}

export interface LoopDetectionResult {
  looping: boolean;
  reason: string;
  suggestion: string;
  repeatedFile?: string;
  repeatedTool?: string;
}

interface LoopDetectorOptions {
  /** Number of consecutive identical calls before flagging a loop. */
  threshold?: number;
  /** How far back to look in the call history. */
  windowSize?: number;
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.replace(/\\/g, "/").toLowerCase().trim();
}

function toolTarget(record: ToolCallRecord): string {
  const args = record.args;
  if (record.toolName === "read" || record.toolName === "write" || record.toolName === "edit") {
    return normalizePath(args.path || args.file_path || args.file || "");
  }
  if (record.toolName === "bash") {
    return normalizePath(args.command || "");
  }
  if (record.toolName === "grep" || record.toolName === "find") {
    return `${normalizePath(args.pattern || "")}|${normalizePath(args.path || "")}`;
  }
  if (record.toolName === "cdev") {
    return normalizePath(args.task || "");
  }
  return normalizePath(JSON.stringify(args));
}

function isReportPath(path: string): boolean {
  return path.includes(".pi/cdev/reports/");
}

export function detectLoop(
  recentCalls: ToolCallRecord[],
  options: LoopDetectorOptions = {},
): LoopDetectionResult {
  const threshold = options.threshold ?? 3;
  const windowSize = options.windowSize ?? 12;
  const calls = recentCalls.slice(-windowSize);

  if (calls.length < threshold) {
    return { looping: false, reason: "", suggestion: "" };
  }

  // Check consecutive identical tool+target repetition.
  for (let i = calls.length - 1; i >= threshold - 1; i--) {
    const current = calls[i];
    const target = toolTarget(current);
    let consecutive = 1;
    for (let j = i - 1; j >= 0; j--) {
      const prev = calls[j];
      if (prev.toolName === current.toolName && toolTarget(prev) === target) {
        consecutive++;
      } else {
        break;
      }
    }
    if (consecutive >= threshold && target) {
      const isReport = isReportPath(target);
      return {
        looping: true,
        reason: `${current.toolName} called ${consecutive} times on the same target`,
        suggestion: `Stop repeating ${current.toolName} on this target. Instead, ${isReport ? "read the source files the report references and edit them directly" : "move forward or escalate to the user"}.`,
        repeatedFile: isReport ? target : undefined,
        repeatedTool: current.toolName,
      };
    }
  }

  // Check for report-only bouncing: last N calls are all reads and most are reports.
  const reads = calls.filter((c) => c.toolName === "read");
  const reportReads = reads.filter((c) => isReportPath(toolTarget(c)));
  if (reads.length >= threshold && reportReads.length >= Math.ceil(reads.length * 0.75) && reportReads.length >= 2) {
    return {
      looping: true,
      reason: "re-reading report files without acting on source files",
      suggestion: "Stop re-reading reports. Read the source files mentioned in the report and apply the edits directly.",
      repeatedTool: "read",
    };
  }

  return { looping: false, reason: "", suggestion: "" };
}

export function extractToolCallsFromEntries(entries: unknown[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    // Tool execution events emitted by Pi.
    if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
      const toolName = typeof e.toolName === "string" ? e.toolName : undefined;
      const args = e.args && typeof e.args === "object" && !Array.isArray(e.args)
        ? (e.args as Record<string, unknown>)
        : {};
      if (toolName) {
        calls.push({ toolName, args });
      }
      continue;
    }

    // Message entries.
    if (e.type === "message") {
      const message = e.message as Record<string, unknown> | undefined;
      if (!message) continue;

      // Assistant messages may contain tool_calls.
      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls as Record<string, unknown>[]) {
          const fn = tc.function && typeof tc.function === "object" && !Array.isArray(tc.function)
            ? (tc.function as Record<string, unknown>)
            : undefined;
          const toolName = typeof tc.name === "string"
            ? tc.name
            : typeof fn?.name === "string"
              ? fn.name
              : "";
          const argsObj = tc.arguments && typeof tc.arguments === "object" && !Array.isArray(tc.arguments)
            ? (tc.arguments as Record<string, unknown>)
            : {};
          if (toolName) {
            calls.push({ toolName, args: argsObj });
          }
        }
        continue;
      }

      // Tool result messages expose the tool that was invoked.
      if (message.role === "toolResult" && typeof message.toolName === "string") {
        const toolName = message.toolName;
        // Args may be stored on the message or reconstructed from content.
        const args = message.args && typeof message.args === "object" && !Array.isArray(message.args)
          ? (message.args as Record<string, unknown>)
          : {};
        calls.push({ toolName, args });
      }
    }
  }
  return calls;
}
