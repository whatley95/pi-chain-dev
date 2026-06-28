import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

// ── 1. Add buildMinimalSessionSnapshot to extension-context.ts ──
const extCtxFile = path.join(root, "src", "extension-context.ts");
let extCtx = fs.readFileSync(extCtxFile, "utf-8");

const newFunc = `
/** Build a minimal snapshot for scout runs — header + last N entries only.
 *  Scouts read files independently and don't need full conversation history.
 *  This reduces serialization, sanitization, temp file I/O, and child process startup.
 */
export function buildMinimalSessionSnapshot(sessionManager: SessionSnapshotSource, maxEntries = 5): string | null {
  try {
    const header = sessionManager.getHeader();
    if (!header || typeof header !== "object") return null;
    const branchEntries = sessionManager.getBranch();
    if (!Array.isArray(branchEntries)) return null;

    const headerLine = JSON.stringify(header);
    const tail = branchEntries.slice(-maxEntries);
    const lines = [headerLine, ...tail.map((e) => JSON.stringify(e))];
    return lines.join("\n") + "\n";
  } catch {
    return buildSessionSnapshotJsonlImpl(sessionManager);
  }
}
`;

const marker = "export function buildSessionSnapshotJsonl(sessionManager: SessionSnapshotSource, maxTokens?: number): string | null {\n  return buildSessionSnapshotJsonlImpl(sessionManager, maxTokens);\n}";
const insertIdx = extCtx.indexOf(marker) + marker.length;
extCtx = extCtx.slice(0, insertIdx) + newFunc + extCtx.slice(insertIdx);
fs.writeFileSync(extCtxFile, extCtx);

// ── 2. Add scout snapshot trimming to fork-orchestrator.ts ──
const forkFile = path.join(root, "src", "fork-orchestrator.ts");
let fork = fs.readFileSync(forkFile, "utf-8");

const stage1Func = "  async function runStage1Run(label: string, stageTask: string, profile?: StageProfile, subTask?: ParallelSubTask): Promise<ForkResult> {\n    const prompt = buildStage1Prompt(stageTask, customExplorePrompt, editMode, cwd, subTask, quick);\n    return runStageWithRetry({\n      cwd,\n      task: prompt,\n      stageLabel: label,\n      forkSessionJsonl: forkSessionSnapshotJsonl,";

const stage1New = `  async function runStage1Run(label: string, stageTask: string, profile?: StageProfile, subTask?: ParallelSubTask): Promise<ForkResult> {
    const prompt = buildStage1Prompt(stageTask, customExplorePrompt, editMode, cwd, subTask, quick);
    // Scouts read files independently — trim snapshot to header+last 5 entries
    const MIN_SCOUT_ENTRIES = 6;
    const sl = forkSessionSnapshotJsonl.trim().split("\n");
    const trimmedSnapshot = sl.length > MIN_SCOUT_ENTRIES
      ? sl.slice(0, 1).concat(sl.slice(-(MIN_SCOUT_ENTRIES - 1))).join("\n") + "\n"
      : forkSessionSnapshotJsonl;
    return runStageWithRetry({
      cwd,
      task: prompt,
      stageLabel: label,
      forkSessionJsonl: trimmedSnapshot,`;

fork = fork.replace(stage1Func, stage1New);

// Remove sanitizedSessionJsonl from scout runs
const sanitizedLine = "      stageTimeoutMs: scoutTimeoutMs,\n      sanitizedSessionJsonl: sanitizedSnapshot,";
const sanitizedNew = "      stageTimeoutMs: scoutTimeoutMs,";
fork = fork.replace(sanitizedLine, sanitizedNew);

fs.writeFileSync(forkFile, fork);
console.log("Done!");
