import { buildResearchPrompt } from "./prompts.js";
import { runStageWithRetry } from "./fork-stage.js";
import { getFinalAssistantText } from "./runner-events.js";
import { parseStage1Findings } from "./json-extract.js";
import { emptyFailedResult, type StageProfile, type ForkResult, type AutoForkDetails } from "./types.js";

export interface RunCdevResearchOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl: string;
  stageProfile: StageProfile;
  customPrompt?: string;
  stageTimeoutMs?: number;
  onProgress?: (stage: "research", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}

export async function runCdevResearch(opts: RunCdevResearchOptions): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, task, forkSessionSnapshotJsonl, stageProfile, customPrompt,
          stageTimeoutMs = 600_000,
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  onProgress?.("research", stageProfile.thinking ? `${stageProfile.provider}:${stageProfile.id} • ${stageProfile.thinking}` : `${stageProfile.provider}:${stageProfile.id}`);

  const prompt = buildResearchPrompt(task, customPrompt, cwd);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task: prompt,
      stageLabel: "research",
      forkSessionJsonl: forkSessionSnapshotJsonl,
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
      toolMode: "scout",
      stageTimeoutMs,
      retries: 1,
      onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult(task, `Research failed: ${message}`);
  }

  const text = getFinalAssistantText(result.messages) || "";
  const findings = parseStage1Findings(text) ?? null;
  const details: AutoForkDetails = { stage1: null, stage2: null, research: findings };

  if (!text) {
    result.errorMessage = result.errorMessage || "Research produced no output";
  }

  return { result, details };
}
