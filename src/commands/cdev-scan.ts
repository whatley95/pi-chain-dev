import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutoForkConfig } from "../config.js";
import { runAutoFork } from "../fork-orchestrator.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession } from "../history.js";
import { indexFindingsAsync } from "../memory.js";
import { scanProject, formatScanReport } from "../scan.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  logError,
} from "../extension-context.js";
import { writeProjectSetting } from "../settings-helpers.js";

const DEEP_SCAN_TASK = `Scan this project's architecture, conventions, and patterns. Generate 3 focused prompts for future cdev use:
1. explore — what to focus on during exploration (stack-specific patterns, conventions, key areas)
2. synthesize — how to structure synthesis reports (what risks to flag, what ordering matters)
3. review — what to check during code review (project-specific pitfalls, conventions, anti-patterns)

Read package.json, key source files, config files, and directory structure. Return ONLY the 3 prompts in this format:

EXPLORE_PROMPT:
<text>

SYNTHESIZE_PROMPT:
<text>

REVIEW_PROMPT:
<text>`;

function savePrompts(cwd: string, prompts: { explore: string; synthesize: string; review: string }): void {
  writeProjectSetting(cwd, "prompts", prompts);
  writeProjectSetting(cwd, "promptsEnabled", true);
}

export async function handleScan(args: string, ctx: ExtensionContext, config: AutoForkConfig, updateAutoStatus: (ctx: ExtensionContext) => void): Promise<boolean> {
  const trimmed = args.trim();

  if (trimmed === "scan deep") {
    const profiles = resolveStageProfiles(config);
    const themedBg = makeThemedBg(ctx, config.themed);
    if (profiles.warning) {
      ctx.ui.notify(profiles.warning, "warn");
      return true;
    }
    ctx.ui.notify("Deep scanning project (stage 1 → stage 2)...", "info");
    try {
      const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager);
      if (!snapshot) { ctx.ui.notify("Cannot snapshot session.", "error"); return true; }

      const scanTask = withAuditGuard(DEEP_SCAN_TASK);
      const scanStartTime = Date.now();
      const onProgress = (stage: string, model: string) => {
        if (stage === "scout") {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `🔍 Scout exploring…  (${model})`)]);
        } else {
          ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `⚒️ Forge synthesizing…  (${model})`)]);
        }
      };
      onProgress("scout", profiles.stage1.id);
      const { result, details: scanDetails } = await runAutoFork({
        cwd: ctx.cwd,
        task: scanTask,
        forkSessionSnapshotJsonl: snapshot,
        stage1Profile: profiles.stage1,
        stage2Profile: profiles.stage2,
        onProgress,
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal: undefined,
      });
      ctx.ui.setWidget("cdev-progress", undefined);

      saveSession(ctx.cwd, DEEP_SCAN_TASK, false, scanStartTime, scanDetails, result);
      if (result.errorMessage) logError(ctx.cwd, "deep-scan-fork", new Error(result.errorMessage));
      if (config.memory) {
        indexFindingsAsync({
          task: DEEP_SCAN_TASK,
          resultText: getFinalAssistantText(result.messages) || "",
          stage1Model: scanDetails.stage1?.model ?? profiles.stage1.id,
          stage2Model: scanDetails.stage2?.model ?? profiles.stage2.id,
          isReview: false,
          quick: false,
          cost: result.usage?.cost ?? 0,
          cwd: ctx.cwd,
        });
      }

      const text = getFinalAssistantText(result.messages) || "";
      const exploreMatch = text.match(/EXPLORE_PROMPT:\s*\n([\s\S]*?)(?=\n\nSYNTHESIZE_PROMPT:|$)/i);
      const synthMatch = text.match(/SYNTHESIZE_PROMPT:\s*\n([\s\S]*?)(?=\n\nREVIEW_PROMPT:|$)/i);
      const reviewMatch = text.match(/REVIEW_PROMPT:\s*\n([\s\S]*?)$/i);

      const explore = exploreMatch?.[1]?.trim() || "";
      const synthesize = synthMatch?.[1]?.trim() || "";
      const review = reviewMatch?.[1]?.trim() || "";

      if (!explore && !review) {
        ctx.ui.notify("Could not parse prompts from model output. Falling back to template scan.", "warn");
        return true;
      }

      savePrompts(ctx.cwd, { explore, synthesize, review });

      ctx.ui.notify(
        `Deep scan complete!\nScout: ${scanDetails.stage1?.model || "?"}\nForge: ${scanDetails.stage2?.model || "?"}\n\nUse these prompts with:\n  /cdev prompts on|off`,
        "info"
      );
      updateAutoStatus(ctx);
    } catch (err) {
      logError(ctx.cwd, "deep-scan", err);
      ctx.ui.notify(`Deep scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return true;
  }

  if (trimmed === "scan") {
    ctx.ui.notify("Scanning project for stack detection...", "info");
    try {
      const result = scanProject(ctx.cwd);
      const report = formatScanReport(result);
      savePrompts(ctx.cwd, {
        explore: result.prompts.explore ?? "",
        synthesize: result.prompts.synthesize ?? "",
        review: result.prompts.review ?? "",
      });
      ctx.ui.notify(report, "info");
      updateAutoStatus(ctx);
    } catch (err) {
      logError(ctx.cwd, "template-scan", err);
      ctx.ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return true;
  }

  return false;
}
