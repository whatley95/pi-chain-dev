/**
 * Full two-stage fork mode handler for cdev (default path).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkParamsType } from "../tool.js";
import { runAutoFork } from "../runner.js";
import { writeReportFile } from "../report.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession, findPreviousSession } from "../history.js";
import {
  logError, recordForkCost, maybeNotifyCostAlert, maybeWarnSessionSize,
  formatForkResultOutput, formatCost, makeThemedBg,
  withAuditGuard, resolveStageProfiles, getSessionForkCost,
} from "../extension-context.js";
import { indexFindingsAsync, getMemoryContext } from "../memory.js";
import { clearProgress, withUiDetails, buildReportUiDetails,
  formatProgressDetail, modelLabel, checkForkBudget,
} from "./shared-helpers.js";
import { computeReportDiff, formatReportDiff, parseStage1Findings } from "../json-extract.js";
import { safeDisplayText } from "../text-width.js";
import type { ForkResult } from "../types.js";
import { formatStage1FindingsForStage2 } from "../fork-orchestrator.js";

export async function handleFullFork(
  p: AutoForkParamsType,
  ctx: ExtensionContext,
  config: Awaited<ReturnType<typeof import("../config.js").loadConfig>>,
  signal: AbortSignal | undefined,
  themedBg: ReturnType<typeof makeThemedBg>,
  snapshot: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }> {
  const task = p.task!; // validated by dispatcher
  const profiles = resolveStageProfiles(config);

  const quick: boolean = p.quick ?? false;
  const auditedTask = withAuditGuard(task);

  // Prepend relevant past findings as context — compensates for clean child sessions
  // Load project map and memory context in parallel since they are independent.
  const mapPromise = config.memory ? import("../project-map.js").then((m) => m.loadProjectMap(ctx.cwd)) : Promise.resolve(null);
  const memoryContextPromise = config.memory ? Promise.resolve(getMemoryContext(task, ctx.cwd)) : Promise.resolve(null);
  const [map, memoryContext] = await Promise.all([mapPromise, memoryContextPromise]);
  const enrichedTask = memoryContext ? `${memoryContext}\n---\n${auditedTask}` : auditedTask;

  const budget = checkForkBudget(config, ctx.cwd, enrichedTask,
    profiles.stage1, profiles.stage2,
    { quick, snapshot });
  if (!budget.allowed) {
    return {
      content: [{ type: "text" as const, text: budget.error }],
      details: budget.details,
      isError: budget.isError,
    };
  }

  if (config.maxSessionCost && config.maxSessionCost > 0) {
    const remaining = config.maxSessionCost - getSessionForkCost(ctx.cwd);
    if (remaining > 0 && budget.estimatedCost > remaining * 0.5) {
      ctx.ui.notify(`This cdev fork is estimated at ${formatCost(budget.estimatedCost)}, which is more than 50% of the remaining session budget (${formatCost(remaining)}).`, "warn");
    }
  }

  const isPlan = p.plan === true;
  const parallel = Math.max(1, Math.min(3, Number.isFinite(p.parallel) ? (p.parallel as number) : (config.parallel ?? 1)));
  const parallelBackup = typeof p.parallelBackup === "boolean" ? p.parallelBackup : (config.parallelBackup ?? false);
  const useParallel = parallel > 1 && !quick;

  // Holder for the result object, populated once runAutoFork returns.
  // onUpdate is invoked before that, so it must read through a mutable ref.
  const resultRef: { current: ForkResult | null } = { current: null };

  const onProgress = (stage: string, model: string) => {
    if (stage === "scout") {
      const icon = useParallel ? "🔀" : "🔍";
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} Scout exploring…  (${model})`)]);
    } else {
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${isPlan ? "📋" : "⚒️"} Forge ${isPlan ? "planning" : "synthesizing"}…  (${model})`)]);
    }
  };
  onProgress("scout", modelLabel(profiles.stage1));
  const startTime = Date.now();
  const { result, details } = await runAutoFork({
    cwd: ctx.cwd,
    task: enrichedTask,
    forkSessionSnapshotJsonl: snapshot,
    stage1Profile: profiles.stage1,
    stage1bProfile: config.stage1b,
    stage1cProfile: config.stage1c,
    stage1BackupProfile: config.stage1Backup,
    stage2Profile: profiles.stage2,
    customExplorePrompt: config.promptsEnabled ? config.prompts?.explore : undefined,
    customSynthesizePrompt: config.promptsEnabled ? config.prompts?.synthesize : undefined,
    customPlanPrompt: config.promptsEnabled ? config.prompts?.plan : undefined,
    quick,
    plan: isPlan,
    parallel,
    parallelBackup,
    scoutTimeoutMs: config.profileTimeouts?.scout ?? config.scoutTimeoutMs,
    forgeTimeoutMs: config.profileTimeouts?.forge ?? config.forgeTimeoutMs,
    confidenceGates: config.confidenceGates,
    onProgress,
    onUpdate: (update) => {
      const isScout = update.stage.includes("exploration") || update.stage === "scout";
      const icon = isScout ? "🔍" : isPlan ? "📋" : "⚒️";
      const label = isScout ? "Scout" : isPlan ? "Planner" : "Forge";
      const detail = formatProgressDetail(update);
      const scoutSummary = isScout ? summarizeScoutActivity(resultRef.current, update.activity) : "";
      ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${label} ${update.stage}…${scoutSummary ? `  ${scoutSummary}` : ""}${detail ? `  · ${detail}` : ""}`)]);
    },
    extensions: config.extensions,
    environment: config.environment,
    offline: config.offline,
    signal,
    map,
  });
  resultRef.current = result;
  clearProgress(ctx);

  const current = saveSession(ctx.cwd, task, false, startTime, details, result);
  const finalText = getFinalAssistantText(result.messages) || "";

  let reportRelPath = "";
  if (!quick && details.stage2 && !result.errorMessage) {
    const reportText = finalText;
    if (reportText) {
      const slugBase = task
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 60);
      const slug = `${slugBase}-${Date.now().toString(36)}`;
      const { reportRelPath: savedPath } = writeReportFile({
        cwd: ctx.cwd,
        fileName: `${slug}.md`,
        title: isPlan ? "cdev plan" : "cdev report",
        body: reportText,
      });
      reportRelPath = savedPath;
    }
  }
  if (result.errorMessage) logError(ctx.cwd, "full-mode", new Error(result.errorMessage));
  const forkCost = result.usage?.cost ?? 0;
  recordForkCost(ctx.cwd, forkCost);
  maybeNotifyCostAlert(ctx, config);
  if (config.memory) {
    indexFindingsAsync({
      task,
      resultText: finalText,
      stage1Model: config.stage1.id,
      stage2Model: p.quick ? undefined : config.stage2.id,
      stage1bModel: config.stage1b?.id || undefined,
      stage1cModel: config.stage1c?.id || undefined,
      stage1BackupModel: config.stage1Backup?.id || undefined,
      isReview: false,
      quick: p.quick ?? false,
      cost: result.usage?.cost ?? 0,
      cwd: ctx.cwd,
    });
  }

  const isError = result.exitCode > 0 && !finalText;
  let resultText = formatForkResultOutput(result, details);

  if (quick) {
    const findings = parseStage1Findings(finalText);
    const readable = findings
      ? formatStage1FindingsForStage2(findings)
      : resultText || result.errorMessage || result.stderr || "(scout produced no output)";
    const diagnostics: string[] = [];
    if (result.stopReason && result.stopReason !== "stop") diagnostics.push(`stop reason: ${result.stopReason}`);
    if (result.errorMessage) diagnostics.push(`error: ${result.errorMessage}`);
    const diagnosticLine = diagnostics.length > 0 ? `\n\n⚠️ ${diagnostics.join(" · ")}` : "";
    resultText = `🔍 cdev quick (read-only) findings\n\n${readable}${diagnosticLine}\n\n---\nℹ️ Quick mode is read-only. No files were created or modified.`;
  }

  // Compare to previous report on same task, if available
  const previous = findPreviousSession(ctx.cwd, task);
  if (previous?.resultText && previous.id !== current.id) {
    const diff = computeReportDiff(previous.resultText, finalText);
    if (diff.added.length > 0 || diff.removed.length > 0) {
      resultText += "\n\n---\n📊 Changes vs previous report\n\n" + formatReportDiff(diff);
    }
  }

  maybeWarnSessionSize(ctx);

  const reportNote = reportRelPath
    ? `\n\n---\n📄 ${isPlan ? "Plan" : "Report"} saved: ${reportRelPath}\n${isPlan ? "Review the plan before implementing." : "After implementing findings, update this file to track what was done (check off items, add notes). Use /cdev review ${reportRelPath} to get a second opinion."}`
    : "";

  return {
    content: [{ type: "text" as const, text: safeDisplayText(resultText + reportNote) }],
    details: withUiDetails(details, buildReportUiDetails(finalText, {
      mode: isPlan ? "plan" : quick ? "quick" : useParallel ? "parallel" : "fork",
      task,
      reportPath: reportRelPath || undefined,
    })),
    isError,
  };
}

function summarizeScoutActivity(result: ForkResult | null, latestActivity?: string): string {
  const tools = result && Array.isArray(result.activities) ? result.activities as { toolName?: string; status?: string; type?: string; displayText?: string }[] : [];
  const completedReads = tools.filter((t) => t.toolName === "read" && t.status === "completed").length;
  const runningReads = tools.filter((t) => t.toolName === "read" && t.status === "running").length;
  const completedSearches = tools.filter((t) => (t.toolName === "rg" || t.toolName === "grep") && t.status === "completed").length;
  const runningSearches = tools.filter((t) => (t.toolName === "rg" || t.toolName === "grep") && t.status === "running").length;
  const parts: string[] = [];

  if (runningReads > 0) {
    parts.push(`reading ${runningReads} file${runningReads === 1 ? "" : "s"}`);
  } else if (completedReads > 0) {
    parts.push(`read ${completedReads} file${completedReads === 1 ? "" : "s"}`);
  }

  if (runningSearches > 0) {
    parts.push(`searching ${runningSearches}`);
  } else if (completedSearches > 0) {
    parts.push(`${completedSearches} search`);
  }

  // Show the most recent running tool call (file path or command) for extra context.
  const latestRunning = tools.find((t) => t.status === "running" && t.displayText);
  if (latestRunning?.displayText) {
    const short = latestRunning.displayText.replace(/\s+/g, " ").trim();
    if (short && !parts.some((p) => p.includes(short))) {
      parts.push(short.length > 35 ? `${short.slice(0, 34)}…` : short);
    }
  }

  if (parts.length === 0 && latestActivity) {
    return latestActivity;
  }
  return parts.join(" · ");
}
