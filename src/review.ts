import * as fs from "node:fs";
import * as path from "node:path";
import { buildReviewPrompt, buildFileReviewPrompt, buildDiffReviewPrompt } from "./prompts.js";
import { runStageWithRetry } from "./fork-stage.js";
import { extractFilePaths } from "./memory.js";
import { isPathUnderCwd } from "./path-guards.js";
import type { StageProfile, ForkResult, AutoForkDetails } from "./types.js";
import { emptyFailedResult } from "./types.js";

interface RunReviewOptions {
  cwd: string;
  task: string;
  stageProfile: StageProfile;
  forkSessionJsonl?: string;
  stageTimeoutMs?: number;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}

async function runReviewStage(
  opts: RunReviewOptions,
  errorContext: string,
): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, task, stageProfile, forkSessionJsonl = JSON.stringify({}) + "\n",
          stageTimeoutMs = 180_000,
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  onProgress?.("forge", stageProfile.thinking ? `${stageProfile.provider}:${stageProfile.id} • ${stageProfile.thinking}` : `${stageProfile.provider}:${stageProfile.id}`);

  let result: ForkResult;
  try {
    result = await runStageWithRetry({
      cwd,
      task,
      stageLabel: "review",
      forkSessionJsonl: forkSessionJsonl,
      stageProfile,
      extensions,
      environment,
      offline,
      signal,
      noTools: true,
      toolMode: "forge",
      stageTimeoutMs,
      retries: 1,
      onUpdate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = emptyFailedResult(errorContext, `${errorContext} failed: ${message}`);
  }

  return { result, details: { stage1: null, stage2: result } };
}

export async function runCdevReview(opts: {
  cwd: string;
  forkSessionSnapshotJsonl: string;
  stageProfile: StageProfile;
  stageTimeoutMs?: number;
  customReviewPrompt?: string;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, forkSessionSnapshotJsonl, stageProfile,
          stageTimeoutMs,
          customReviewPrompt,
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  const reviewTask = buildReviewPrompt(customReviewPrompt);
  return runReviewStage({
    cwd,
    task: reviewTask,
    stageProfile,
    forkSessionJsonl: forkSessionSnapshotJsonl,
    stageTimeoutMs,
    onProgress,
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  }, "Review");
}

export async function runFileReview(opts: {
  cwd: string;
  filePath: string;
  fileContent: string;
  stageProfile: StageProfile;
  stageTimeoutMs?: number;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, filePath, fileContent, stageProfile,
          stageTimeoutMs,
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  const filePaths = extractFilePaths(fileContent, cwd);
  const referencedFiles: Record<string, string> = {};
  const MAX_REF_FILES = 15;
  const MAX_REF_BYTES = 100_000;
  const MAX_SINGLE_FILE_BYTES = 50_000;
  let totalBytes = 0;
  for (const candidate of filePaths.slice(0, MAX_REF_FILES)) {
    if (totalBytes >= MAX_REF_BYTES) break;
    const fullPath = path.resolve(cwd, candidate);
    if (!isPathUnderCwd(cwd, fullPath)) continue;
    if (!fs.existsSync(fullPath)) continue;
    try {
      const size = fs.statSync(fullPath).size;
      if (size > MAX_SINGLE_FILE_BYTES) {
        referencedFiles[candidate] = "(file too large; skipped)";
        continue;
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      if (totalBytes + content.length > MAX_REF_BYTES) {
        referencedFiles[candidate] = content.slice(0, MAX_REF_BYTES - totalBytes) + "\n\n... (truncated, file too large)";
        totalBytes = MAX_REF_BYTES;
      } else {
        referencedFiles[candidate] = content;
        totalBytes += content.length;
      }
    } catch { /* skip unreadable files */ }
  }

  const reviewTask = buildFileReviewPrompt(filePath, fileContent, referencedFiles);
  return runReviewStage({
    cwd,
    task: reviewTask,
    stageProfile,
    stageTimeoutMs,
    onProgress,
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  }, `File review ${filePath}`);
}

export async function runDiffReview(opts: {
  cwd: string;
  diffSpec: string;
  diffContent: string;
  stageProfile: StageProfile;
  stageTimeoutMs?: number;
  onProgress?: (stage: "scout" | "forge", model: string) => void;
  onUpdate?: (update: { stage: string; activity?: string; cost?: number; tokens?: number }) => void;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
}): Promise<{ result: ForkResult; details: AutoForkDetails }> {
  const { cwd, diffSpec, diffContent, stageProfile,
          stageTimeoutMs,
          extensions = null, environment = {}, offline = true, signal, onProgress, onUpdate } = opts;

  const reviewTask = buildDiffReviewPrompt(diffSpec, diffContent);
  return runReviewStage({
    cwd,
    task: reviewTask,
    stageProfile,
    stageTimeoutMs,
    onProgress,
    onUpdate,
    extensions,
    environment,
    offline,
    signal,
  }, `Diff review ${diffSpec}`);
}
