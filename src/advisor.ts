import { buildAdvisorPrompt } from "./prompts.js";
import { runStageWithRetry } from "./fork-stage.js";
import { getFinalAssistantText } from "./runner-events.js";
import { emptyFailedResult, type StageProfile, type ForkResult, type AutoForkDetails } from "./types.js";

export interface RunCdevAdvisorOptions {
  cwd: string;
  question: string;
  forkSessionSnapshotJsonl: string;
  advisorProfile: StageProfile;
  scoutProfile?: StageProfile;
  customPrompt?: string;
  scoutTimeoutMs?: number;
  advisorTimeoutMs?: number;
  includeScout?: boolean;
  onProgress?: (stage: "scout" | "advisor", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}

export async function runCdevAdvisor(opts: RunCdevAdvisorOptions): Promise<{ result: ForkResult; details: AutoForkDetails; scoutText?: string }> {
  const {
    cwd,
    question,
    forkSessionSnapshotJsonl,
    advisorProfile,
    scoutProfile,
    customPrompt,
    scoutTimeoutMs = 600_000,
    advisorTimeoutMs = 180_000,
    includeScout = true,
    extensions = null,
    environment = {},
    offline = true,
    signal,
    onProgress,
    onUpdate,
  } = opts;

  const details: AutoForkDetails = { stage1: null, stage2: null };
  let scoutText = "";

  if (includeScout && scoutProfile?.provider && scoutProfile?.id) {
    onProgress?.("scout", scoutProfile.thinking ? `${scoutProfile.provider}:${scoutProfile.id} • ${scoutProfile.thinking}` : `${scoutProfile.provider}:${scoutProfile.id}`);

    const scoutPrompt = `You are a scout gathering evidence for an advisor. The advisor will help the main agent answer this question:

${question}

Explore the project efficiently. Return raw findings as JSON matching the cdev exploration schema with summary, findings (file/observation/evidence/confidence), deadEnds, assumptions, openQuestions, and coverage counts. Do NOT synthesize a final answer — just gather evidence.`;

    const scoutResult = await runStageWithRetry({
      cwd,
      task: scoutPrompt,
      stageLabel: "advisor-scout",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: scoutProfile,
      extensions,
      environment,
      offline,
      signal,
      toolMode: "scout",
      stageTimeoutMs: scoutTimeoutMs,
      retries: 1,
      onUpdate,
    });

    if (scoutResult.exitCode === 0) {
      scoutText = getFinalAssistantText(scoutResult.messages) || "";
      details.stage1 = scoutResult;
    }
  }

  onProgress?.("advisor", advisorProfile.thinking ? `${advisorProfile.provider}:${advisorProfile.id} • ${advisorProfile.thinking}` : `${advisorProfile.provider}:${advisorProfile.id}`);

  const prompt = buildAdvisorPrompt(question, scoutText || undefined, customPrompt, cwd);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task: prompt,
      stageLabel: "advisor",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile: advisorProfile,
      extensions,
      environment,
      offline,
      signal,
      toolMode: "forge",
      stageTimeoutMs: advisorTimeoutMs,
      retries: 1,
      onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult(question, `Advisor failed: ${message}`);
  }

  details.stage2 = result;

  if (!result.errorMessage && !getFinalAssistantText(result.messages)) {
    result.errorMessage = result.errorMessage || "Advisor produced no output";
  }

  return { result, details, scoutText: scoutText || undefined };
}
