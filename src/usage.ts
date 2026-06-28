/**
 * Shared ForkResult usage aggregation helpers.
 */

import type { ForkResult, UsageStats } from "./types.js";

export function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function resolveCost(usage: { cost?: { total?: number } | number }): number {
  if (!usage || typeof usage !== "object") return 0;
  return typeof usage.cost === "object" && usage.cost !== null
    ? finiteNumber((usage.cost as { total?: number }).total)
    : finiteNumber(usage.cost);
}

export function addUsage(target: UsageStats, source: Partial<UsageStats> & { cost?: { total?: number } | number; totalTokens?: number }): void {
  target.input += finiteNumber(source.input);
  target.output += finiteNumber(source.output);
  target.cacheRead += finiteNumber(source.cacheRead);
  target.cacheWrite += finiteNumber(source.cacheWrite);
  target.cost += resolveCost(source);
  target.turns += finiteNumber(source.turns);
  const contextTokens = finiteNumber(source.contextTokens) || finiteNumber(source.totalTokens);
  if (contextTokens) {
    target.contextTokens = (target.contextTokens || 0) + contextTokens;
  }
}

export function mergeUsage(a: UsageStats, b: UsageStats): UsageStats {
  return {
    input: finiteNumber(a.input) + finiteNumber(b.input),
    output: finiteNumber(a.output) + finiteNumber(b.output),
    cacheRead: finiteNumber(a.cacheRead) + finiteNumber(b.cacheRead),
    cacheWrite: finiteNumber(a.cacheWrite) + finiteNumber(b.cacheWrite),
    cost: finiteNumber(a.cost) + finiteNumber(b.cost),
    turns: finiteNumber(a.turns) + finiteNumber(b.turns),
    contextTokens: Math.max(finiteNumber(a.contextTokens), finiteNumber(b.contextTokens)),
  };
}

export function addNestedForkUsage(result: ForkResult, message: { role?: unknown; toolName?: unknown; toolCallId?: unknown; details?: { results?: unknown } }): boolean {
  // Accept both event-stream (toolResult) and session-JSONL (tool) roles.
  // turn_end / agent_end event payloads may nest cdev fork results under
  // toolResults / messages arrays where role is absent or "tool".
  const results = message.details?.results;
  if (!Array.isArray(results)) return false;

  const role = message.role;
  const isToolResult = role === "toolResult" || role === "tool";
  if (!isToolResult && message.toolName !== "cdev") {
    // For aggregate events, only process if nested results contain usage data
    const hasUsage = results.some(r => {
      const u = (r as { usage?: unknown }).usage;
      return u && typeof u === "object";
    });
    if (!hasUsage) return false;
  }

  let changed = false;
  for (const forkResult of results) {
    const usage = (forkResult as { usage?: Partial<UsageStats> & { cost?: { total?: number } | number; totalTokens?: number } }).usage;
    if (!usage || typeof usage !== "object") continue;
    addUsage(result.usage, usage);
    changed = true;
  }

  return changed;
}
