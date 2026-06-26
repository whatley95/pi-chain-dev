import { buildStage1Prompt, buildStage2Prompt, buildPlanPrompt, buildYoloReviewSnapshot, buildYoloFixTask } from "./prompts.js";
import { parseStage1Findings, parseStage2Report } from "./json-extract.js";
import { runStageWithRetry, sanitizeSessionJsonl } from "./fork-stage.js";
import { getFinalAssistantText } from "./runner-events.js";
import { runCdevReview } from "./review.js";
import { withAuditGuard, formatCost, estimateForkCost, getSessionForkCost } from "./extension-context.js";
import { saveSession } from "./history.js";
import { writeReportFile } from "./report.js";
import { loadProjectMap, splitTaskByMap, type ParallelSubTask } from "./project-map.js";
import type { StageProfile, ForkResult, UsageStats, AutoForkDetails, Stage1Findings, AutoForkConfig, YoloConfig, ConfidenceGateConfig } from "./types.js";
import { emptyUsage, emptyFailedResult, evaluateConfidenceGates } from "./types.js";

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function addUsage(into: UsageStats, usage: UsageStats | undefined | null): UsageStats {
  if (!usage) return into;
  into.input += usage.input || 0;
  into.output += usage.output || 0;
  into.cacheRead += usage.cacheRead || 0;
  into.cacheWrite += usage.cacheWrite || 0;
  into.cost += usage.cost || 0;
  into.turns += usage.turns || 0;
  into.contextTokens = Math.max(into.contextTokens, usage.contextTokens || 0);
  return into;
}

export interface RunAutoForkOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl: string;
  stage1Profile: StageProfile;
  stage1bProfile?: StageProfile;
  stage1cProfile?: StageProfile;
  stage1BackupProfile?: StageProfile;
  stage2Profile: StageProfile;
  customExplorePrompt?: string;
  customSynthesizePrompt?: string;
  customPlanPrompt?: string;
  quick?: boolean;
  verify?: boolean;
  plan?: boolean;
  parallel?: number;
  parallelBackup?: boolean;
  scoutTimeoutMs?: number;
  forgeTimeoutMs?: number;
  editMode?: boolean;
  confidenceGates?: ConfidenceGateConfig;
  onProgress?: (stage: string, model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}

export async function runAutoFork(opts: RunAutoForkOptions): Promise<{
  result: ForkResult;
  details: AutoForkDetails;
}> {
  const { cwd, task, forkSessionSnapshotJsonl, stage1Profile, stage1bProfile,
          stage1cProfile, stage1BackupProfile, stage2Profile, customExplorePrompt,
          customSynthesizePrompt, customPlanPrompt,
          quick = false, verify = false, plan = false, editMode = false,
          confidenceGates,
          extensions = null, environment = {}, offline = true, signal } = opts;

  const scoutTimeoutMs = Number.isFinite(opts.scoutTimeoutMs) && (opts.scoutTimeoutMs as number) > 0
    ? (opts.scoutTimeoutMs as number)
    : 600_000;
  const forgeTimeoutMs = Number.isFinite(opts.forgeTimeoutMs) && (opts.forgeTimeoutMs as number) > 0
    ? (opts.forgeTimeoutMs as number)
    : 180_000;

  const details: AutoForkDetails = { stage1: null, stage2: null };

  const sanitizedSnapshot = sanitizeSessionJsonl(forkSessionSnapshotJsonl);

  const onUpdate = opts.onUpdate;
  const parallel = Math.max(1, Math.min(3, Number.isFinite(opts.parallel) ? (opts.parallel as number) : 1));
  const useParallel = parallel > 1 && !quick && !verify;

  function modelLabel(prof: StageProfile): string {
    return prof.thinking ? `${prof.provider}:${prof.id} • ${prof.thinking}` : `${prof.provider}:${prof.id}`;
  }

  async function runStage1Run(label: string, stageTask: string, profile?: StageProfile, subTask?: ParallelSubTask): Promise<ForkResult> {
    const prompt = buildStage1Prompt(stageTask, customExplorePrompt, editMode, cwd, subTask);
    return runStageWithRetry({
      cwd,
      task: prompt,
      stageLabel: label,
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: profile || stage1Profile,
      extensions,
      environment,
      offline,
      signal,
      stageTimeoutMs: scoutTimeoutMs,
      sanitizedSessionJsonl: sanitizedSnapshot,
      retries: 1,
      toolMode: "scout",
      onUpdate,
    });
  }

  let stage1Result: ForkResult;
  let stage1Findings: Stage1Findings | null = null;

  if (useParallel) {
    const map = loadProjectMap(cwd);
    const subTasks = splitTaskByMap(task, map, parallel);
    const workerProfiles: (StageProfile | undefined)[] = [stage1Profile, stage1bProfile, stage1cProfile];
    const activeProfiles = workerProfiles.slice(0, subTasks.length).map((p) => p || stage1Profile);
    const labels = subTasks.map((s) => `scout ${s.label}`);
    const modelLabels = activeProfiles.map(modelLabel);
    opts.onProgress?.("scout", modelLabels.join(" + "));

    const workerRuns = await Promise.all(
      subTasks.map((subTask, i) =>
        runStage1Run(labels[i], task, activeProfiles[i], subTask).then((r): { result: ForkResult; subTask: ParallelSubTask; index: number } => ({ result: r, subTask, index: i }))
      )
    );

    const failedRuns = workerRuns.filter((w) => w.result.exitCode !== 0 || !getFinalAssistantText(w.result.messages));
    const backupProfile = stage1BackupProfile && stage1BackupProfile.provider && stage1BackupProfile.id ? stage1BackupProfile : stage1Profile;
    const useBackup = opts.parallelBackup !== false && failedRuns.length > 0 && backupProfile;
    let backupRuns: { result: ForkResult; subTask: ParallelSubTask; index: number }[] | undefined;

    if (useBackup) {
      opts.onProgress?.("scout", `backup ${modelLabel(backupProfile)} taking over ${failedRuns.length} failed sub-task(s)`);
      backupRuns = await Promise.all(
        failedRuns.map((w) =>
          runStage1Run(`backup ${w.subTask.label}`, task, backupProfile, w.subTask).then((r): { result: ForkResult; subTask: ParallelSubTask; index: number } => ({ result: r, subTask: w.subTask, index: w.index }))
        )
      );
      for (const b of backupRuns) {
        workerRuns[b.index] = b;
      }
    }

    const successful = workerRuns.filter((w) => w.result.exitCode === 0 && getFinalAssistantText(w.result.messages));
    if (successful.length === 0) {
      return {
        result: {
          ...emptyFailedResult(task, `Parallel scout failed: all ${workerRuns.length} sub-task scout(s) failed`),
          provider: stage1Profile.provider,
          model: stage1Profile.id,
        },
        details,
      };
    }

    const combinedUsage: UsageStats = emptyUsage();

    for (const w of workerRuns) addUsage(combinedUsage, w.result.usage);

    const maxDuration = Math.max(0, ...workerRuns.map((w) => w.result.durationMs ?? 0));
    const backupMaxDuration = useBackup && backupRuns
      ? Math.max(0, ...backupRuns.map((b) => b.result.durationMs ?? 0))
      : 0;
    const totalDuration = useBackup ? maxDuration + backupMaxDuration : maxDuration;

    const stderrLines: string[] = [
      `[cdev] parallel mode: ${successful.length}/${workerRuns.length} scout(s) succeeded${useBackup ? " (backup used)" : ""}`,
      ...workerRuns.map((w) => {
        const status = w.result.exitCode === 0 && getFinalAssistantText(w.result.messages) ? "ok" : "failed";
        const dur = fmtDuration(w.result.durationMs);
        return `  scout ${w.subTask.label}: ${status}${dur ? ` in ${dur}` : ""}${w.result.errorMessage ? ` — ${w.result.errorMessage}` : ""}`;
      }),
    ];

    let mergedFindings: Stage1Findings | null = null;
    for (const w of successful) {
      const text = getFinalAssistantText(w.result.messages) || "";
      const findings = parseStage1Findings(text);
      if (!findings) continue;
      if (!mergedFindings) {
        mergedFindings = findings;
      } else {
        mergedFindings = mergeStage1Findings(mergedFindings, findings);
      }
    }

    stage1Result = {
      ...successful[0].result,
      task,
      usage: combinedUsage,
      stderr: stderrLines.filter(Boolean).join("\n"),
      durationMs: totalDuration,
    };
    details.stage1 = successful[0].result;
    details.stage1b = workerRuns.find((w) => w.subTask.label === "B")?.result ?? null;
    details.stage1c = workerRuns.find((w) => w.subTask.label === "C")?.result ?? null;
    details.stage1Backup = backupRuns?.[0]?.result ?? null;
    stage1Findings = mergedFindings;
    if (!stage1Findings) {
      stage1Result.stderr += "\n[cdev] parallel mode: no valid findings produced by any scout";
    }
  } else if (verify) {
    const secondProfile = stage1bProfile && stage1bProfile.provider && stage1bProfile.id ? stage1bProfile : stage1Profile;
    const modelA = stage1Profile.thinking ? `${stage1Profile.provider}:${stage1Profile.id} • ${stage1Profile.thinking}` : `${stage1Profile.provider}:${stage1Profile.id}`;
    const modelB = secondProfile.thinking ? `${secondProfile.provider}:${secondProfile.id} • ${secondProfile.thinking}` : `${secondProfile.provider}:${secondProfile.id}`;
    opts.onProgress?.("scout", `Scout A ${modelA} + Scout B ${modelB}`);

    const [settledA, settledB] = await Promise.allSettled([
      runStage1Run("exploration A", task, stage1Profile).then((r) => {
        opts.onProgress?.("scout", `Scout A ${modelA} done`);
        return r;
      }),
      runStage1Run("exploration B", task, secondProfile).then((r) => {
        opts.onProgress?.("scout", `Scout B ${modelB} done`);
        return r;
      }),
    ]);

    const emptyRun = (label: string, err?: string): ForkResult => ({
      ...emptyFailedResult(task, `${label} failed${err ? `: ${err}` : ""}`),
      provider: stage1Profile.provider,
      model: stage1Profile.id,
    });

    const runA = settledA.status === "fulfilled" ? settledA.value : emptyRun("exploration A", settledA.reason instanceof Error ? settledA.reason.message : String(settledA.reason));
    const runB = settledB.status === "fulfilled" ? settledB.value : emptyRun("exploration B", settledB.reason instanceof Error ? settledB.reason.message : String(settledB.reason));

    if (!getFinalAssistantText(runA.messages) && !getFinalAssistantText(runB.messages)) {
      return {
        result: {
          ...emptyFailedResult(task, `Verify mode exploration failed: both scout runs failed (${runA.errorMessage || "A"}; ${runB.errorMessage || "B"})`),
          provider: stage1Profile.provider,
          model: stage1Profile.id,
        },
        details,
      };
    }

    const combinedUsage: UsageStats = emptyUsage();
    addUsage(combinedUsage, runA.usage);
    addUsage(combinedUsage, runB.usage);

    const aDuration = fmtDuration(runA.durationMs);
    const bDuration = fmtDuration(runB.durationMs);
    const primaryRun = getFinalAssistantText(runA.messages) ? runA : runB;
    stage1Result = {
      ...primaryRun,
      task,
      usage: combinedUsage,
      stderr: [
        `[cdev] verify mode: Scout A ${modelA}${aDuration ? ` in ${aDuration}` : ""} | Scout B ${modelB}${bDuration ? ` in ${bDuration}` : ""}`,
        runA.stderr,
        runB.stderr,
      ].filter(Boolean).join("\n"),
      durationMs: Math.max(runA.durationMs ?? 0, runB.durationMs ?? 0),
    };
    details.stage1 = runA;
    details.stage1b = runB;

    const textA = getFinalAssistantText(runA.messages) || "";
    const textB = getFinalAssistantText(runB.messages) || "";
    const findingsA = parseStage1Findings(textA);
    const findingsB = parseStage1Findings(textB);

    const validationA = findingsA ? validateStage1Findings(findingsA, "exploration A") : { valid: false, reason: "exploration A: output was not valid JSON findings" };
    const validationB = findingsB ? validateStage1Findings(findingsB, "exploration B") : { valid: false, reason: "exploration B: output was not valid JSON findings" };

    if (validationA.valid && validationB.valid) {
      const contradictions = detectContradictions(findingsA!, findingsB!);
      stage1Findings = mergeStage1Findings(findingsA!, findingsB!);
      if (contradictions.length > 0) {
        stage1Findings.contradictions = contradictions;
        stage1Result.stderr += `\n[cdev] verify mode: found ${contradictions.length} contradiction(s) between scout runs\n`;
      }
      stage1Result.stderr += `\n[cdev] verify mode: merged ${findingsA!.findings.length} + ${findingsB!.findings.length} findings into ${stage1Findings.findings.length} unique findings\n`;
    } else if (validationA.valid) {
      stage1Findings = findingsA;
      stage1Result.stderr += `\n[cdev] verify mode: exploration A valid, B invalid (${validationB.reason}); using A\n`;
    } else if (validationB.valid) {
      stage1Findings = findingsB;
      stage1Result.stderr += `\n[cdev] verify mode: exploration B valid, A invalid (${validationA.reason}); using B\n`;
    } else {
      stage1Result.stderr += `\n[cdev] verify mode: both explorations invalid (${validationA.reason}; ${validationB.reason})\n`;
    }
  } else {
    stage1Result = await runStage1Run("exploration", task);
    details.stage1 = stage1Result;

    const stage1Text = getFinalAssistantText(stage1Result.messages) || "";
    stage1Findings = parseStage1Findings(stage1Text);
    const validation = stage1Findings ? validateStage1Findings(stage1Findings, "exploration") : { valid: false, reason: "output was not valid JSON findings" };
    const stage1Usage: UsageStats = stage1Result.usage ? { ...stage1Result.usage } : emptyUsage();

    const reExploreCheck = shouldReExplore(stage1Findings, verify);
    const gateCheck = stage1Findings ? evaluateConfidenceGates(stage1Findings, confidenceGates) : { passed: false, reasons: ["no valid findings"] };
    const gateAutoReExplore = confidenceGates?.autoReExplore ?? true;
    const needsMoreExploration = reExploreCheck.should || (!gateCheck.passed && gateAutoReExplore);
    if (!gateCheck.passed && !gateAutoReExplore) {
      stage1Result.stderr += `\n[cdev] confidence gate failed but autoReExplore is off: ${gateCheck.reasons.join("; ")}\n`;
    }

    // Fire validation retry and/or coverage pass concurrently where possible.
    // They are independent, so parallelism saves wall-clock time without reducing accuracy.
    let retryResult: ForkResult | undefined;
    let secondRun: ForkResult | undefined;

    if (!validation.valid || needsMoreExploration) {
      const promises: Promise<ForkResult>[] = [];
      const labels: string[] = [];

      if (!validation.valid) {
        stage1Result.stderr += `\n[cdev] ${validation.reason}; retrying stage 1 with stricter prompt\n`;
        promises.push(runStage1Run("exploration (validation retry)", task));
        labels.push("validation retry");
      }

      if (needsMoreExploration) {
        const reason = gateCheck.passed ? reExploreCheck.reason : `confidence gate failed: ${gateCheck.reasons.join("; ")}`;
        stage1Result.stderr += `\n[cdev] ${reason}; running a second exploration pass\n`;
        promises.push(runStage1Run("exploration (coverage pass)", task));
        labels.push("coverage pass");
      }

      const results = await Promise.all(promises);
      if (labels.includes("validation retry")) {
        retryResult = results[labels.indexOf("validation retry")];
      }
      if (labels.includes("coverage pass")) {
        secondRun = results[labels.indexOf("coverage pass")];
      }
    }

    if (retryResult) {
      addUsage(stage1Usage, retryResult.usage);
      details.stage1 = retryResult;
      const retryText = getFinalAssistantText(retryResult.messages) || "";
      const retryFindings = parseStage1Findings(retryText);
      const retryValidation = retryFindings ? validateStage1Findings(retryFindings, "exploration retry") : { valid: false, reason: "retry output was not valid JSON findings" };

      if (retryValidation.valid) {
        stage1Findings = retryFindings;
        stage1Result = {
          ...retryResult,
          usage: stage1Usage,
          stderr: [stage1Result.stderr, retryResult.stderr].filter(Boolean).join("\n"),
        };
      } else {
        stage1Result.stderr += `\n[cdev] ${retryValidation.reason}; proceeding with raw text`;
        stage1Findings = null;
        stage1Result.usage = stage1Usage;
      }
    }

    if (secondRun && stage1Findings) {
      addUsage(stage1Usage, secondRun.usage);
      const secondText = getFinalAssistantText(secondRun.messages) || "";
      const secondFindings = parseStage1Findings(secondText);
      const secondValidation = secondFindings ? validateStage1Findings(secondFindings, "coverage pass") : { valid: false, reason: "coverage pass output was not valid JSON findings" };
      if (secondValidation.valid && secondFindings) {
        stage1Findings = mergeStage1Findings(stage1Findings, secondFindings);
        stage1Result = {
          ...secondRun,
          usage: stage1Usage,
          stderr: [stage1Result.stderr, secondRun.stderr].filter(Boolean).join("\n"),
        };
        stage1Result.stderr += `\n[cdev] merged second pass: ${stage1Findings.findings.length} total findings`;
        const finalGate = evaluateConfidenceGates(stage1Findings, confidenceGates);
        if (!finalGate.passed) {
          stage1Result.stderr += `\n[cdev] confidence gates still not met after second pass: ${finalGate.reasons.join("; ")}`;
        }
      } else {
        stage1Result.stderr += `\n[cdev] coverage pass invalid (${secondValidation.reason}); using first pass`;
        stage1Result.usage = stage1Usage;
      }
    }
  }

  if (stage1Result.exitCode > 0 && !getFinalAssistantText(stage1Result.messages) && !stage1Findings) {
    return {
      result: {
        ...stage1Result,
        task,
        errorMessage: `Exploration stage failed: ${stage1Result.errorMessage || stage1Result.stderr || "unknown error"}`,
      },
      details,
    };
  }

  if (quick) {
    const quickResult: ForkResult = {
      ...stage1Result,
      task,
      stopReason: "quick",
    };
    return { result: quickResult, details };
  }

  opts.onProgress?.("forge", stage2Profile.thinking ? `${stage2Profile.provider}:${stage2Profile.id} • ${stage2Profile.thinking}` : `${stage2Profile.provider}:${stage2Profile.id}`);

  const stage1Text = stage1Findings
    ? formatStage1FindingsForStage2(stage1Findings)
    : getFinalAssistantText(stage1Result.messages) || stage1Result.stderr || "(no output from exploration stage)";

  if (plan) {
    opts.onProgress?.("forge", stage2Profile.thinking ? `${stage2Profile.provider}:${stage2Profile.id} • ${stage2Profile.thinking}` : `${stage2Profile.provider}:${stage2Profile.id}`);
    const planTask = buildPlanPrompt(task, stage1Text, customPlanPrompt);
    let planResult: ForkResult;
    try {
      planResult = await runStageWithRetry({
        cwd,
        task: planTask,
        stageLabel: "plan",
        forkSessionJsonl: forkSessionSnapshotJsonl,
        stageProfile: stage2Profile,
        extensions,
        environment,
        offline,
        signal,
        noTools: true,
        toolMode: "forge",
        stageTimeoutMs: forgeTimeoutMs,
        sanitizedSessionJsonl: sanitizedSnapshot,
        retries: 1,
        onUpdate,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      planResult = emptyFailedResult(task, `Plan stage failed: ${message}`);
    }
    details.stage2 = planResult;

    const combinedUsage: UsageStats = emptyUsage();
    addUsage(combinedUsage, stage1Result.usage);
    addUsage(combinedUsage, planResult.usage);

    const finalResult: ForkResult = {
      task,
      exitCode: planResult.exitCode > 0 ? planResult.exitCode : 0,
      messages: planResult.messages,
      stderr: [stage1Result.stderr, planResult.stderr].filter(Boolean).join("\n"),
      usage: combinedUsage,
      provider: planResult.provider || stage2Profile.provider,
      model: planResult.model || stage2Profile.id,
      stopReason: planResult.stopReason,
      errorMessage: planResult.errorMessage,
      durationMs: (stage1Result.durationMs ?? 0) + (planResult.durationMs ?? 0),
    };

    return { result: finalResult, details };
  }

  const stage2Task = buildStage2Prompt(task, stage1Text, customSynthesizePrompt, editMode);

  let stage2Result: ForkResult;
  try {
    stage2Result = await runStageWithRetry({
      cwd,
      task: stage2Task,
      stageLabel: "synthesis",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: stage2Profile,
      extensions,
      environment,
      offline,
      signal,
      noTools: !editMode,
      toolMode: editMode ? undefined : "forge",
      stageTimeoutMs: forgeTimeoutMs,
      sanitizedSessionJsonl: sanitizedSnapshot,
      retries: 1,
      onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stage2Result = emptyFailedResult(task, `Stage 2 (synthesis) failed: ${message}`);
  }
  details.stage2 = stage2Result;

  const combinedUsage: UsageStats = emptyUsage();
  addUsage(combinedUsage, stage1Result.usage);
  addUsage(combinedUsage, stage2Result.usage);

  const finalResult: ForkResult = {
    task,
    exitCode: stage2Result.exitCode > 0 ? stage2Result.exitCode : 0,
    messages: stage2Result.messages,
    stderr: [stage1Result.stderr, stage2Result.stderr].filter(Boolean).join("\n"),
    usage: combinedUsage,
    provider: stage2Result.provider || stage2Profile.provider,
    model: stage2Result.model || stage2Profile.id,
    stopReason: stage2Result.stopReason,
    errorMessage: stage2Result.errorMessage,
    durationMs: (stage1Result.durationMs ?? 0) + (stage2Result.durationMs ?? 0),
  };

  const stage2Text = getFinalAssistantText(stage2Result.messages);
  const stage2Report = stage2Text ? parseStage2Report(stage2Text) : null;
  if (stage2Report) {
    finalResult.stderr += "\n[cdev] forge produced structured JSON report\n";
  } else if (stage2Text) {
    finalResult.stderr += "\n[cdev] forge output was not valid structured JSON; using raw text\n";
  }

  return { result: finalResult, details };
}

export function formatStage1FindingsForStage2(findings: Stage1Findings): string {
  const lines: string[] = [];
  lines.push(`Summary: ${findings.summary}`);
  if (findings.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const f of findings.findings) {
      const parts: string[] = [`- [${f.confidence || "medium"}] ${f.observation}`];
      if (f.file) parts.push(`  file: ${f.file}`);
      if (f.evidence) parts.push(`  evidence: ${f.evidence}`);
      lines.push(parts.join("\n"));
    }
  }
  if (findings.deadEnds?.length) {
    lines.push("");
    lines.push("Dead ends:");
    for (const d of findings.deadEnds) lines.push(`- ${d}`);
  }
  if (findings.assumptions?.length) {
    lines.push("");
    lines.push("Assumptions:");
    for (const a of findings.assumptions) lines.push(`- ${a}`);
  }
  if (findings.openQuestions?.length) {
    lines.push("");
    lines.push("Open questions:");
    for (const q of findings.openQuestions) lines.push(`- ${q}`);
  }
  if (findings.contradictions?.length) {
    lines.push("");
    lines.push("Contradictions between scout runs:");
    for (const c of findings.contradictions) {
      lines.push(`- ${c.summary}`);
      lines.push(`  A: ${c.observationA}`);
      lines.push(`  B: ${c.observationB}`);
    }
  }
  if (findings.coverage) {
    const c = findings.coverage;
    lines.push("");
    lines.push("Coverage:");
    lines.push(`- Files inspected: ${c.filesInspected}`);
    lines.push(`- Files cited: ${c.filesCited}`);
    lines.push(`- Commands run: ${c.commandsRun}`);
    if (c.unreadLikelyFiles !== undefined) lines.push(`- Unread likely files: ${c.unreadLikelyFiles}`);
  }
  return lines.join("\n");
}

export function countLowConfidenceFindings(findings: Stage1Findings): number {
  return findings.findings.filter((f) => f.confidence === "low").length;
}

export function shouldReExplore(findings: Stage1Findings | null, verify: boolean): { should: boolean; reason?: string } {
  if (!findings) return { should: true, reason: "stage 1 produced no valid structured findings" };
  if (findings.findings.length === 0) return { should: true, reason: "stage 1 returned zero findings" };
  if (findings.findings.length < 3 && !verify) return { should: true, reason: `only ${findings.findings.length} finding(s); likely insufficient coverage` };
  const lowConfidenceCount = countLowConfidenceFindings(findings);
  if (lowConfidenceCount / findings.findings.length > 0.5) return { should: true, reason: `${Math.round((lowConfidenceCount / findings.findings.length) * 100)}% of findings are low confidence` };
  if (findings.openQuestions?.some((q) => /critical|blocker|unknown/i.test(q))) return { should: true, reason: "open questions contain critical/blocker unknowns" };
  return { should: false };
}

export function validateStage1Findings(findings: Stage1Findings, source: string): { valid: boolean; reason?: string } {
  if (!findings.summary || findings.summary.trim().length < 5) {
    return { valid: false, reason: `${source}: summary missing or too short` };
  }
  if (findings.findings.length === 0) {
    return { valid: false, reason: `${source}: no findings returned` };
  }
  const withObservations = findings.findings.filter(f => f.observation && f.observation.trim().length > 0);
  if (withObservations.length === 0) {
    return { valid: false, reason: `${source}: findings lack observations` };
  }
  return { valid: true };
}

function normalizeObservation(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function findingsOverlap(a: string, b: string): boolean {
  const na = normalizeObservation(a);
  const nb = normalizeObservation(b);
  if (na === nb) return true;
  if (na.length > 20 && nb.length > 20) {
    return na.startsWith(nb.slice(0, 40)) || nb.startsWith(na.slice(0, 40));
  }
  return false;
}

export function mergeStage1Findings(a: Stage1Findings, b: Stage1Findings): Stage1Findings {
  const merged: Stage1Findings = {
    summary: a.summary,
    findings: [...a.findings],
    deadEnds: [...(a.deadEnds ?? [])],
    assumptions: [...(a.assumptions ?? [])],
    openQuestions: [...(a.openQuestions ?? [])],
    contradictions: a.contradictions ? [...a.contradictions] : undefined,
  };
  for (const f of b.findings) {
    if (!merged.findings.some(existing => findingsOverlap(existing.observation, f.observation))) {
      merged.findings.push(f);
    }
  }
  for (const list of ["deadEnds", "assumptions", "openQuestions"] as const) {
    const source = b[list] ?? [];
    for (const item of source) {
      if (!merged[list]?.some(existing => normalizeObservation(existing) === normalizeObservation(item))) {
        merged[list] = merged[list] ?? [];
        merged[list].push(item);
      }
    }
  }
  if (b.findings.length > a.findings.length && b.summary.length >= a.summary.length) {
    merged.summary = b.summary;
  }
  if (a.coverage && b.coverage) {
    merged.coverage = {
      filesInspected: Math.max(a.coverage.filesInspected, b.coverage.filesInspected),
      filesCited: Math.max(a.coverage.filesCited, b.coverage.filesCited),
      commandsRun: Math.max(a.coverage.commandsRun, b.coverage.commandsRun),
      unreadLikelyFiles: Math.max(a.coverage.unreadLikelyFiles ?? 0, b.coverage.unreadLikelyFiles ?? 0),
    };
  } else if (a.coverage || b.coverage) {
    merged.coverage = a.coverage ?? b.coverage;
  }
  return merged;
}

export function detectContradictions(a: Stage1Findings, b: Stage1Findings): import("./types.js").FindingContradiction[] {
  const contradictions: import("./types.js").FindingContradiction[] = [];
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  for (const fa of a.findings) {
    for (const fb of b.findings) {
      if (fa.observation === fb.observation) continue;
      const oa = normalize(fa.observation);
      const ob = normalize(fb.observation);
      // Same file but opposite confidence is a soft contradiction
      if (fa.file && fb.file && fa.file === fb.file) {
        const opposite = (fa.confidence === "high" && fb.confidence === "low") || (fa.confidence === "low" && fb.confidence === "high");
        if (opposite && oa.length > 20 && ob.length > 20 && (oa.startsWith(ob.slice(0, 30)) || ob.startsWith(oa.slice(0, 30)))) {
          contradictions.push({
            observationA: fa.observation,
            observationB: fb.observation,
            summary: `Same file (${fa.file}) but opposite confidence: A=${fa.confidence}, B=${fb.confidence}`,
          });
        }
      }
      // Direct negation keywords
      const negationWords = ["not ", "no ", "does not", "doesn't", "cannot", "can't", "missing", "absent"];
      const aNeg = negationWords.some((w) => oa.includes(w));
      const bNeg = negationWords.some((w) => ob.includes(w));
      if (aNeg !== bNeg && oa.length > 25 && ob.length > 25 && (oa.startsWith(ob.slice(0, 35)) || ob.startsWith(oa.slice(0, 35)))) {
        contradictions.push({
          observationA: fa.observation,
          observationB: fb.observation,
          summary: "One finding affirms while the other negates a closely related point",
        });
      }
    }
  }
  return contradictions.slice(0, 5);
}

export type ReviewVerdict = "pass" | "needs-work" | "blocked" | "unknown";

export function parseReviewVerdict(text: string): ReviewVerdict {
  const match = text.match(/## Result\b([\s\S]*?)(?=##\s|$)/i);
  if (!match) return "unknown";
  const section = match[1].toLowerCase();
  if (section.includes("needs-work") || section.includes("needs work")) return "needs-work";
  if (section.includes("blocked")) return "blocked";
  if (section.includes("pass")) return "pass";
  return "unknown";
}

export interface YoloRoundResult {
  round: number;
  review: {
    result: ForkResult;
    details: AutoForkDetails;
    reportPath: string;
    verdict: ReviewVerdict;
  };
  fix?: {
    result: ForkResult;
    details: AutoForkDetails;
    reportPath: string;
  };
}

export interface YoloLoopResult {
  initial: {
    result: ForkResult;
    details: AutoForkDetails;
    reportPath: string;
    reportText: string;
  };
  rounds: YoloRoundResult[];
  totalCost: number;
  finalVerdict: ReviewVerdict;
  finalReportPath: string;
  finalReportText: string;
}

export interface RunYoloLoopOptions extends Omit<RunAutoForkOptions, "onProgress" | "onUpdate"> {
  config: AutoForkConfig;
  yoloConfig: Required<Omit<YoloConfig, "reviewProfile" | "fixProfile">> & Pick<YoloConfig, "reviewProfile" | "fixProfile">;
  reviewProfile: StageProfile;
  fixProfile: StageProfile;
  customReviewPrompt?: string;
  yoloReviewTimeoutMs?: number;
  yoloFixTimeoutMs?: number;
  onProgress?: (stage: "scout" | "forge" | "review" | "fix", model: string, round?: number) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
}

export function yoloSlug(task: string): string {
  return task
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);
}

export async function runYoloLoop(opts: RunYoloLoopOptions): Promise<YoloLoopResult> {
  const {
    cwd, task, forkSessionSnapshotJsonl, stage1Profile, stage1bProfile, stage2Profile,
    yoloConfig, reviewProfile, fixProfile, customExplorePrompt, customSynthesizePrompt, customReviewPrompt,
    scoutTimeoutMs, forgeTimeoutMs, yoloReviewTimeoutMs, yoloFixTimeoutMs,
    extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate,
  } = opts;

  const baseSlug = yoloSlug(task);

  function addUsage(acc: UsageStats, usage: UsageStats | undefined | null): void {
    if (!usage) return;
    acc.input += usage.input || 0;
    acc.output += usage.output || 0;
    acc.cacheRead += usage.cacheRead || 0;
    acc.cacheWrite += usage.cacheWrite || 0;
    acc.cost += usage.cost || 0;
    acc.turns += usage.turns || 0;
    acc.contextTokens = Math.max(acc.contextTokens, usage.contextTokens || 0);
  }

  const totalUsage: UsageStats = emptyUsage();

  function checkYoloBudget(_spentSoFar: number, nextEstimate: number): { allowed: boolean; reason?: string } {
    const maxForkCost = opts.config.maxForkCost ?? 0;
    const maxSessionCost = opts.config.maxSessionCost ?? 0;
    if (maxForkCost > 0 && nextEstimate > maxForkCost) {
      return { allowed: false, reason: `next fork estimate ${formatCost(nextEstimate)} exceeds maxForkCost ${formatCost(maxForkCost)}` };
    }
    const sessionCost = getSessionForkCost(cwd);
    if (maxSessionCost > 0 && sessionCost + nextEstimate > maxSessionCost) {
      return { allowed: false, reason: `YOLO session cost would reach ${formatCost(sessionCost + nextEstimate)}, exceeding maxSessionCost ${formatCost(maxSessionCost)}` };
    }
    return { allowed: true };
  }

  const initialStart = Date.now();
  const { result: initialResult, details: initialDetails } = await runAutoFork({
    cwd,
    task: withAuditGuard(task),
    forkSessionSnapshotJsonl,
    stage1Profile,
    stage1bProfile,
    stage2Profile,
    customExplorePrompt,
    customSynthesizePrompt,
    quick: false,
    verify: false,
    scoutTimeoutMs,
    forgeTimeoutMs,
    onProgress: (stage, model) => onProgress?.(stage as "scout" | "forge" | "review" | "fix", model),
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  });
  addUsage(totalUsage, initialResult.usage);

  const initialText = getFinalAssistantText(initialResult.messages) || "";
  let initialReportPath = "";
  if (initialText && !initialResult.errorMessage) {
    const { reportRelPath } = writeReportFile({
      cwd,
      fileName: `yolo-${baseSlug}-initial-${Date.now().toString(36)}.md`,
      title: "cdev YOLO initial report",
      body: initialText,
    });
    initialReportPath = reportRelPath;
    saveSession(cwd, `yolo initial: ${task}`, false, initialStart, initialDetails, initialResult);
  }

  const rounds: YoloRoundResult[] = [];
  let finalVerdict: ReviewVerdict = "unknown";
  let finalReportPath = initialReportPath;
  let finalReportText = initialText;
  let latestReport = initialText;

  for (let round = 1; round <= yoloConfig.maxRounds; round++) {
    if (!latestReport) break;

    const reviewEstimate = estimateForkCost({
      task: buildYoloReviewSnapshot("", latestReport, round),
      stage1Profile,
      stage2Profile: reviewProfile,
      forkSessionSnapshotJsonl,
      quick: true,
    });
    const reviewBudget = checkYoloBudget(totalUsage.cost, reviewEstimate.cost);
    if (!reviewBudget.allowed) {
      finalVerdict = "blocked";
      rounds.push({
        round,
        review: {
          result: emptyFailedResult(task, `YOLO budget blocked before review round ${round}: ${reviewBudget.reason}`),
          details: { stage1: null, stage2: null },
          reportPath: "",
          verdict: "blocked",
        },
      });
      break;
    }

    const reviewStart = Date.now();
    const reviewSnapshot = buildYoloReviewSnapshot(forkSessionSnapshotJsonl, latestReport, round);
    const reviewModelLabel = reviewProfile.thinking
      ? `${reviewProfile.provider}:${reviewProfile.id} • ${reviewProfile.thinking}`
      : `${reviewProfile.provider}:${reviewProfile.id}`;
    onProgress?.("review", reviewModelLabel, round);

    const { result: reviewResult, details: reviewDetails } = await runCdevReview({
      cwd,
      forkSessionSnapshotJsonl: reviewSnapshot,
      stageProfile: reviewProfile,
      stageTimeoutMs: yoloReviewTimeoutMs ?? forgeTimeoutMs,
      customReviewPrompt,
      onProgress: (_stage, model) => onProgress?.("review", model, round),
      onUpdate,
      extensions,
      environment,
      offline,
      signal,
    });
    addUsage(totalUsage, reviewResult.usage);

    const reviewText = getFinalAssistantText(reviewResult.messages) || "";
    const { reportRelPath: reviewReportPath } = writeReportFile({
      cwd,
      fileName: `yolo-${baseSlug}-round${round}-${Date.now().toString(36)}.md`,
      title: `cdev YOLO review round ${round}`,
      reviewer: reviewDetails.stage2?.model ?? "?",
      body: reviewText || "(no review output)",
    });
    finalReportPath = reviewReportPath;
    finalReportText = reviewText;
    saveSession(cwd, `yolo review round ${round}: ${task}`, true, reviewStart, reviewDetails, reviewResult);

    const verdict = parseReviewVerdict(reviewText);
    finalVerdict = verdict;

    const roundResult: YoloRoundResult = {
      round,
      review: {
        result: reviewResult,
        details: reviewDetails,
        reportPath: reviewReportPath,
        verdict,
      },
    };

    if (verdict === "pass" && yoloConfig.stopOnPass) {
      rounds.push(roundResult);
      break;
    }

    if (yoloConfig.autoApply === "manual") {
      roundResult.fix = {
        result: emptyFailedResult(task, "manual mode: waiting for main agent to apply fixes"),
        details: { stage1: null, stage2: null },
        reportPath: "",
      };
      rounds.push(roundResult);
      break;
    }

    const fixEstimate = estimateForkCost({
      task: buildYoloFixTask(task, reviewText, round, yoloConfig.autoApply),
      stage1Profile,
      stage2Profile: fixProfile,
      forkSessionSnapshotJsonl,
      quick: yoloConfig.autoApply !== "auto",
    });
    const fixBudget = checkYoloBudget(totalUsage.cost, fixEstimate.cost);
    if (!fixBudget.allowed) {
      roundResult.fix = {
        result: emptyFailedResult(task, `YOLO budget blocked before fix round ${round}: ${fixBudget.reason}`),
        details: { stage1: null, stage2: null },
        reportPath: "",
      };
      rounds.push(roundResult);
      finalVerdict = "blocked";
      break;
    }

    const fixStart = Date.now();
    const fixModelLabel = fixProfile.thinking
      ? `${fixProfile.provider}:${fixProfile.id} • ${fixProfile.thinking}`
      : `${fixProfile.provider}:${fixProfile.id}`;
    onProgress?.("fix", fixModelLabel, round);

    const fixTask = buildYoloFixTask(task, reviewText, round, yoloConfig.autoApply);
    const { result: fixResult, details: fixDetails } = await runAutoFork({
      cwd,
      task: fixTask,
      forkSessionSnapshotJsonl,
      stage1Profile,
      stage1bProfile,
      stage2Profile: fixProfile,
      customExplorePrompt,
      customSynthesizePrompt,
      quick: false,
      verify: false,
      editMode: yoloConfig.autoApply === "auto",
      scoutTimeoutMs,
      forgeTimeoutMs: yoloFixTimeoutMs ?? forgeTimeoutMs,
      onProgress: (stage, model) => onProgress?.(stage === "scout" || stage === "forge" ? stage : "fix", model, round),
      onUpdate,
      extensions,
      environment,
      offline,
      signal,
    });
    addUsage(totalUsage, fixResult.usage);

    const fixText = getFinalAssistantText(fixResult.messages) || "";
    let fixReportPath = "";
    if (fixText && !fixResult.errorMessage) {
      const { reportRelPath } = writeReportFile({
        cwd,
        fileName: `yolo-${baseSlug}-fix${round}-${Date.now().toString(36)}.md`,
        title: `cdev YOLO ${yoloConfig.autoApply === "auto" ? "auto-fix" : "fix proposal"} round ${round}`,
        body: fixText,
      });
      fixReportPath = reportRelPath;
      finalReportPath = fixReportPath;
      finalReportText = fixText;
      saveSession(cwd, `yolo ${yoloConfig.autoApply === "auto" ? "auto-fix" : "fix proposal"} round ${round}: ${task}`, false, fixStart, fixDetails, fixResult);
    }

    roundResult.fix = {
      result: fixResult,
      details: fixDetails,
      reportPath: fixReportPath,
    };
    rounds.push(roundResult);

    if (fixText) {
      latestReport = fixText;
    }
  }

  return {
    initial: {
      result: initialResult,
      details: initialDetails,
      reportPath: initialReportPath,
      reportText: initialText,
    },
    rounds,
    totalCost: totalUsage.cost,
    finalVerdict,
    finalReportPath,
    finalReportText,
  };
}
