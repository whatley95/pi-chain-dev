/**
 * Shared helper functions used by all cdev mode handlers.
 * Extracted from src/tool.ts to avoid duplication across mode files.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { parsePlanReport, parseStage2Report } from "../json-extract.js";
import {
  cachedBuildSessionSnapshot, estimateForkCost, checkCostBudget, formatCost,
  estimateTokens,
} from "../extension-context.js";
import type { AutoForkDetails, AutoForkUiDetails, StageProfile } from "../types.js";

// ── Snapshot types ──

export interface SnapshotOk {
  snapshot: string;
  snapshotTokens?: number;
}

export interface CompactTrigger {
  autoCompact: { tokens: number; limit: number };
}

export type SnapshotResult = SnapshotOk | CompactTrigger | null;

// ── Snapshot helpers ──

export function resolveSnapshotTokens(snapshot: string, ctx: ExtensionContext): number {
  const usage = ctx.getContextUsage?.();
  if (usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens)) {
    return Math.ceil(usage.tokens);
  }
  return estimateTokens(snapshot);
}

export function resolveContextLimit(ctx: ExtensionContext, config: Awaited<ReturnType<typeof loadConfig>>): number {
  const usage = ctx.getContextUsage?.();
  if (usage && typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow)) {
    return usage.contextWindow;
  }
  return config.modelContextLimit ?? 262_144;
}

export function checkSessionSnapshot(
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof loadConfig>>,
): SnapshotResult {
  const usage = ctx.getContextUsage?.();
  const limit = resolveContextLimit(ctx, config);

  if (
    usage &&
    usage.percent !== null &&
    usage.percent >= 95 &&
    config.autoCompactOnLimit
  ) {
    const tokens = usage.tokens ?? Math.ceil(limit * (usage.percent / 100));
    ctx.ui.notify(`Session snapshot is ~${tokens.toLocaleString()} tokens — auto-compacting parent session. Retry after /compact completes.`, "warn");
    if (ctx.compact) {
      ctx.compact({ customInstructions: "Triggered by cdev because Pi reported the session at 95%+ of the model context limit. Summarize recent work and keep details needed for the next cdev task." });
    }
    return { autoCompact: { tokens, limit } };
  }

  const snapshot = cachedBuildSessionSnapshot(ctx.sessionManager, limit, ctx.cwd);
  if (!snapshot) return null;
  const snapshotTokens = resolveSnapshotTokens(snapshot, ctx);
  if (snapshotTokens > limit * 0.95) {
    if (config.autoCompactOnLimit) {
      ctx.ui.notify(`Session snapshot is ~${snapshotTokens.toLocaleString()} tokens — auto-compacting parent session. Retry after /compact completes.`, "warn");
      if (ctx.compact) {
        ctx.compact({ customInstructions: "Triggered by cdev because the session snapshot exceeded the configured model context limit. Summarize recent work and keep details needed for the next cdev task." });
      }
      return { autoCompact: { tokens: snapshotTokens, limit } };
    }
    ctx.ui.notify(`Session snapshot is ~${snapshotTokens.toLocaleString()} tokens. Consider running /compact to avoid model limit errors.`, "warn");
  }
  return { snapshot, snapshotTokens };
}

export function isCompactTrigger(result: SnapshotResult): result is CompactTrigger {
  return result !== null && "autoCompact" in result;
}

export function formatCompactMessage(result: CompactTrigger): string {
  const { tokens, limit } = result.autoCompact;
  return `cdev: Session snapshot is ~${tokens.toLocaleString()} tokens, nearing the model context limit (${limit.toLocaleString()}). Auto-compacting parent session; retry this task after /compact completes.`;
}

// ── UI helpers ──

export function buildReportUiDetails(text: string | undefined, base: AutoForkUiDetails): AutoForkUiDetails {
  if (!text) return base;
  const report = parseStage2Report(text);
  if (report) {
    return {
      ...base,
      status: report.status,
      groundingScore: report.groundingScore,
      qualityScore: report.qualityScore,
      ungroundedClaimCount: report.ungroundedClaims?.length ?? 0,
      actionItemCount: report.actionItems.length,
      coverage: report.coverage,
    };
  }
  const plan = parsePlanReport(text);
  if (plan) {
    return {
      ...base,
      mode: base.mode ?? "plan",
      status: plan.status,
      groundingScore: plan.groundingScore,
      qualityScore: plan.qualityScore,
      ungroundedClaimCount: plan.ungroundedClaims?.length ?? 0,
      actionItemCount: plan.steps.length,
      coverage: plan.coverage,
    };
  }
  return base;
}

export function withUiDetails(details: AutoForkDetails, ui: AutoForkUiDetails): AutoForkDetails {
  return { ...details, ui };
}

export function modelLabel(prof: { provider: string; id: string; thinking?: string }): string {
  return prof.thinking ? `${prof.provider}:${prof.id} • ${prof.thinking}` : `${prof.provider}:${prof.id}`;
}

export function clearProgress(ctx: ExtensionContext): void {
  ctx.ui.setWidget("cdev-progress", undefined);
}

export function formatProgressDetail(update: { activity?: string; cost?: number; tokens?: number }): string {
  const parts: string[] = [];
  if (update.activity) parts.push(update.activity);
  if (update.tokens && update.tokens > 0) parts.push(`${(update.tokens / 1000).toFixed(1)}k tok`);
  if (update.cost && update.cost > 0) parts.push(formatCost(update.cost));
  return parts.length > 0 ? parts.join(" · ") : "";
}

// ── Diff helpers (used by review mode) ──

import { spawnSync } from "node:child_process";

export function detectVcs(cwd: string): "git" | "svn" | null {
  const gitResult = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf-8" });
  if (gitResult.status === 0) return "git";
  const svnResult = spawnSync("svn", ["info"], { cwd, encoding: "utf-8" });
  if (svnResult.status === 0) return "svn";
  return null;
}

export function runDiff(cwd: string, diffSpec: string, vcs: "git" | "svn"): { stdout: string; stderr: string; status: number | null } {
  if (vcs === "git") {
    const result = spawnSync("git", ["diff", diffSpec], { cwd, maxBuffer: 2 * 1024 * 1024, encoding: "utf-8" });
    return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
  }
  const result = spawnSync("svn", ["diff", "-r", diffSpec], { cwd, maxBuffer: 2 * 1024 * 1024, encoding: "utf-8" });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

// ── Budget check helper (shared by advisor, research, yolo, full-fork) ──

export function checkForkBudget(
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  cwd: string,
  task: string,
  stage1Profile: StageProfile,
  stage2Profile: StageProfile,
  opts?: { quick?: boolean; verify?: boolean; snapshot?: string; costMultiplier?: number; costLabel?: string; unitLabel?: string },
): { allowed: false; error: string; details: { stage1: null; stage2: null }; isError: true } | { allowed: true; estimatedCost: number } {
  // Fast-path: skip estimation when no budget limits configured (unlimited)
  if (config.maxSessionCost === 0 && config.maxForkCost === 0) {
    return { allowed: true, estimatedCost: 0 };
  }
  const estimate = estimateForkCost({
    task,
    stage1Profile,
    stage2Profile,
    quick: opts?.quick,
    verify: opts?.verify,
    forkSessionSnapshotJsonl: opts?.snapshot ?? undefined,
  });
  const multiplier = opts?.costMultiplier ?? 1;
  const cost = estimate.cost * multiplier;
  const budgetCheck = checkCostBudget(config, cwd, cost);
  if (!budgetCheck.allowed) {
    const label = opts?.costLabel ?? "";
    const unit = opts?.unitLabel ? ` ${opts.unitLabel}` : "";
    return {
      allowed: false,
      error: `cdev budget error: ${budgetCheck.reason}
Estimated${label}: ~${formatCost(cost)} (${estimate.inputTokens} input / ${estimate.outputTokens} output tokens)${unit}`,
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }
  return { allowed: true, estimatedCost: cost };
}
