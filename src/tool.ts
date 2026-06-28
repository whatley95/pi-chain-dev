import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { setStageSemaphoreMaxConcurrency } from "./fork-stage.js";
import { setTokenEstimationRatio, makeThemedBg, resolveStageProfiles, logError } from "./extension-context.js";
import { checkSessionSnapshot, isCompactTrigger, formatCompactMessage } from "./modes/shared-helpers.js";
import { handleRecall } from "./modes/recall.js";
import { handleReview } from "./modes/review.js";
import { handleAdvisor } from "./modes/advisor.js";
import { handleResearch } from "./modes/research.js";
import { handleYolo } from "./modes/yolo.js";
import { handleFullFork } from "./modes/full-fork.js";
import { safeDisplayText } from "./text-width.js";

export interface AutoForkParamsType {
  task?: string;
  review?: boolean;
  quick?: boolean;
  plan?: boolean;
  yolo?: boolean;
  research?: boolean;
  advisor?: boolean;
  askAdvisor?: boolean;
  parallel?: number;
  parallelBackup?: boolean;
  recall?: string;
  reviewFile?: string;
  diffSpec?: string;
}

export function validateAutoForkParams(params: Record<string, unknown>): { valid: true; value: AutoForkParamsType } | { valid: false; error: string } {
  const out: AutoForkParamsType = {};
  const errors: string[] = [];

  if (params.task !== undefined) {
    if (typeof params.task !== "string") errors.push("task must be a string");
    else out.task = params.task;
  }
  for (const key of ["review", "quick", "plan", "yolo", "research", "parallelBackup", "advisor", "askAdvisor"] as const) {
    if (params[key] !== undefined) {
      if (typeof params[key] !== "boolean") errors.push(`${key} must be a boolean`);
      else out[key] = params[key];
    }
  }
  for (const key of ["recall", "reviewFile", "diffSpec"] as const) {
    if (params[key] !== undefined) {
      if (typeof params[key] !== "string") errors.push(`${key} must be a string`);
      else out[key] = params[key];
    }
  }
  if (params.parallel !== undefined) {
    if (typeof params.parallel !== "number" || !Number.isFinite(params.parallel)) {
      errors.push("parallel must be a number");
    } else if (params.parallel < 1 || params.parallel > 3) {
      errors.push("parallel must be between 1 and 3");
    } else {
      out.parallel = params.parallel;
    }
  }

  if (errors.length > 0) return { valid: false, error: errors.join("; ") };
  return { valid: true, value: out };
}

export async function executeCdevTool(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const validation = validateAutoForkParams(params);
  if (!validation.valid) {
    return {
      content: [{ type: "text" as const, text: `cdev error: ${validation.error}` }],
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }
  const p = validation.value;
  try {
    const config = loadConfig(ctx.cwd);
    setStageSemaphoreMaxConcurrency(config.maxConcurrentStages ?? 3);
    setTokenEstimationRatio(config.tokenEstimationCharsPerToken ?? 4);
    const themedBg = makeThemedBg(ctx, config.themed);

    // ── Recall mode ──
    if (p.recall !== undefined) {
      return handleRecall(p, ctx, config);
    }

    // ── Review mode ──
    if (p.review) {
      return handleReview(p, ctx, config, signal, themedBg);
    }

    // ── Full two-stage mode (advisor, research, yolo, default fork) ──
    if (!p.task) {
      return {
        content: [{ type: "text" as const, text: "cdev error: task is required for fork mode." }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }

    const profiles = resolveStageProfiles(config);
    if (profiles.warning) {
      return {
        content: [{ type: "text" as const, text: `cdev error: ${profiles.warning}` }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }

    // Build session snapshot once for all remaining modes
    const snapshotResult = checkSessionSnapshot(ctx, config);
    if (snapshotResult === null) {
      return {
        content: [{ type: "text" as const, text: "cdev error: Cannot cdev — failed to snapshot current session context." }],
        details: { stage1: null, stage2: null },
        isError: true,
      };
    }
    if (isCompactTrigger(snapshotResult)) {
      return {
        content: [{ type: "text" as const, text: formatCompactMessage(snapshotResult) }],
        details: { stage1: null, stage2: null, autoCompact: snapshotResult.autoCompact },
      };
    }
    // Don't pass the parent Pi session snapshot to child processes.
    // Child Pis start with clean sessions to avoid LLM API 400 errors
    // ("Messages with role 'tool' must follow a preceding 'tool_calls'").
    // Memory provides project context instead.
    const snapshot = "";

    // ── Advisor mode ──
    if (p.advisor) {
      return handleAdvisor(p, ctx, config, signal, themedBg, snapshot);
    }

    // ── Research mode ──
    if (p.research) {
      return handleResearch(p, ctx, config, signal, themedBg, snapshot);
    }

    // ── YOLO mode ──
    if (p.yolo) {
      return handleYolo(p, ctx, config, signal, themedBg, snapshot);
    }

    // ── Default: full two-stage fork ──
    return handleFullFork(p, ctx, config, signal, themedBg, snapshot);
  } catch (err) {
    ctx.ui.setWidget("cdev-progress", undefined);
    logError(ctx.cwd, "tool", err);
    return {
      content: [{ type: "text" as const, text: safeDisplayText(`cdev error: ${err instanceof Error ? err.message : String(err)}`) }],
      details: { stage1: null, stage2: null },
      isError: true,
    };
  }
}
