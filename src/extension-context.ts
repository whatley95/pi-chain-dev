import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AutoForkConfig } from "./config.js";
import { getResultSummaryText, getFinalAssistantText } from "./runner-events.js";
import type { AutoForkDetails, ForkResult, StageProfile } from "./types.js";
import { memoryTopicCount } from "./memory.js";

export const AUDIT_GUARD = "\n\n⚠️ AUDIT ONLY — DO NOT implement, modify, or write any code. Only report findings and suggestions.";
export const DEFAULT_SIGNATURE = "whatley.xyz";
export const FORK_COST_STATUS_KEY = "cdev-cost";

// ── Cost footer cache ──────────────────────────────────────

interface CostCache {
  key: string;
  totalCost: number;
}

const _costCache = new Map<string, CostCache>();

function hashSessionEntries(entries: unknown[]): string {
  const sample = entries.slice(-50);
  const hash = createHash("sha256").update(String(entries.length)).update(stableStringify(sample)).digest("hex").slice(0, 16);
  return hash;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function withAuditGuard(t: string): string {
  return t + AUDIT_GUARD;
}

export function makeThemedBg(ctx: ExtensionContext, themed: boolean) {
  return (token: string, text: string): string => {
    return bg(token, text, ctx.ui.theme, themed);
  };
}

function bg(token: string, text: string, theme: ExtensionContext["ui"]["theme"], themed: boolean): string {
  if (!themed) return text;
  try {
    return theme.bg(token, text);
  } catch {
    return text;
  }
}

export function getCdevVersion(cwd: string): string {
  try {
    const git = spawnSync("git", ["describe", "--tags", "--always", "--dirty", "--abbrev=7"], { cwd, timeout: 3000 });
    if (git.status === 0 && git.stdout) return git.stdout.toString().trim();
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 3000 });
    if (sha.status === 0 && sha.stdout) return sha.stdout.toString().trim();
  } catch { /* ignore */ }
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    if (pkg.version) return pkg.version;
  } catch { /* ignore */ }
  return "unknown";
}

export function resolveSignature(config: AutoForkConfig): string {
  return config.signature || DEFAULT_SIGNATURE;
}

export interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

export function buildSessionSnapshotJsonl(sessionManager: SessionSnapshotSource): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;
  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

export function resolveStageProfiles(
  config: AutoForkConfig,
): { stage1: StageProfile; stage2: StageProfile; warning?: string } {
  const stage1 = config.stage1;
  const stage2 = config.stage2;

  if (!stage1.provider || !stage1.id || !stage2.provider || !stage2.id) {
    return {
      stage1: { provider: "", id: "", thinking: "minimal" },
      stage2: { provider: "", id: "", thinking: "xhigh" },
      warning: "cdev is not configured. Add 'pi-chain-dev' to settings.json with stage1 and stage2 profiles.\n\nExample:\n{\n  \"pi-chain-dev\": {\n    \"stage1\": { \"provider\": \"openai-codex\", \"id\": \"gpt-5-mini\", \"thinking\": \"minimal\" },\n    \"stage2\": { \"provider\": \"opencode-go\", \"id\": \"deepseek-v4-flash\", \"thinking\": \"xhigh\" }\n  }\n}",
    };
  }

  return { stage1, stage2 };
}

export function formatResultContent(result: ForkResult, details: AutoForkDetails): string {
  const finalText = getFinalAssistantText(result.messages);

  if (result.errorMessage && !finalText) {
    const scoutInfo = details.stage1
      ? ` | Scout: ${details.stage1.model || "?"} (exit ${details.stage1.exitCode})`
      : "";
    const forgeInfo = details.stage2
      ? ` | Forge: ${details.stage2.model || "?"} (exit ${details.stage2.exitCode})`
      : "";
    const costInfo = (result.usage?.cost ?? 0) > 0 ? ` — cost: $${(result.usage?.cost ?? 0).toFixed(4)}` : "";
    return `cdev failed: ${result.errorMessage}${scoutInfo}${forgeInfo}${costInfo}`;
  }

  const summary = finalText || getResultSummaryText(result);

  let header = "";
  const isReview = details.stage1 === null && details.stage2 !== null;
  if (isReview) {
    header += `Review ran with ${details.stage2?.model || "?"}: ${details.stage2?.exitCode ?? "?"} exit\n\n`;
  } else {
    if (details.stage1) {
      header += `Scout (exploration) ran with ${details.stage1.model || "?"}: ${details.stage1.exitCode} exit\n`;
    }
    if (details.stage2) {
      header += `Forge (synthesis) ran with ${details.stage2.model || "?"}: ${details.stage2.exitCode} exit\n`;
    }
    if (header) header += "\n";
  }

  return header + summary;
}

export function updateForkCostStatus(ctx: ExtensionContext): void {
  const config = loadConfig(ctx.cwd);
  if (!config.costFooter) {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
    return;
  }

  const entries = ctx.sessionManager.getEntries();
  const cacheKey = ctx.cwd;
  const entriesHash = hashSessionEntries(entries);
  const cached = _costCache.get(cacheKey);
  let totalCost: number;
  if (cached && cached.key === entriesHash) {
    totalCost = cached.totalCost;
  } else {
    totalCost = 0;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message") {
        const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined;
        if (message?.role === "toolResult" && message?.toolName === "cdev") {
          const details = message.details as AutoForkDetails | undefined;
          if (details?.stage1?.usage?.cost) totalCost += details.stage1.usage.cost;
          if (details?.stage2?.usage?.cost) totalCost += details.stage2.usage.cost;
        }
      }
    }
    _costCache.set(cacheKey, { key: entriesHash, totalCost });
  }

  const segments: string[] = [];
  if (config.auto) segments.push("⚡");
  segments.push("cdev");
  if (totalCost > 0) segments.push(`$${totalCost.toFixed(4)}`);
  if (config.promptsEnabled && (config.prompts?.explore || config.prompts?.review)) segments.push("📋");
  if (config.memory) {
    const topicCount = memoryTopicCount(ctx.cwd);
    if (topicCount > 0) segments.push(`🧠${topicCount}`);
  }

  if (segments.length <= 1) {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
    ctx.ui.setStatus("cdev-memory", undefined);
    return;
  }

  ctx.ui.setStatus(FORK_COST_STATUS_KEY, ctx.ui.theme.fg("dim", segments.join(" | ")));
  ctx.ui.setStatus("cdev-memory", undefined);
}

export function logError(cwd: string, context: string, err: unknown): void {
  try {
    const cdevDir = join(cwd, ".pi", "cdev");
    mkdirSync(cdevDir, { recursive: true });
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      context,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    appendFileSync(join(cdevDir, "errors.jsonl"), record + "\n", "utf-8");
  } catch {
    // fail silently
  }
}
