import { readFileSync, mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AutoForkConfig } from "./config.js";
import { getResultSummaryText, getFinalAssistantText } from "./runner-events.js";
import { parseStage2Report, formatStage2Report } from "./json-extract.js";
import type { AutoForkDetails, ForkResult, StageProfile } from "./types.js";
import { memoryTopicCount } from "./memory.js";
import { BUILD_DATE } from "./build-date.js";

export const AUDIT_GUARD = "\n\n⚠️ AUDIT ONLY — DO NOT implement, modify, or write any code. Only report findings and suggestions.";
export const DEFAULT_SIGNATURE = "whatley.xyz";
export const FORK_COST_STATUS_KEY = "cdev-cost";

// ── Session cost tracking ──────────────────────────────────

const _sessionCostCache = new Map<string, number>();

function sessionCostFilePath(cwd: string): string {
  return join(cwd, ".pi", "cdev", ".session-cost");
}

export function recordForkCost(cwd: string, cost: number): void {
  const current = getSessionForkCost(cwd);
  const next = current + cost;
  _sessionCostCache.set(cwd, next);
  try {
    const path = sessionCostFilePath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(next), "utf-8");
  } catch {
    // ignore persistence failure
  }
}

export function getSessionForkCost(cwd: string): number {
  const cached = _sessionCostCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const path = sessionCostFilePath(cwd);
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8").trim();
      const parsed = parseFloat(raw);
      if (!Number.isNaN(parsed)) {
        _sessionCostCache.set(cwd, parsed);
        return parsed;
      }
    }
  } catch {
    // ignore read failure
  }
  return 0;
}

export function resetSessionForkCost(cwd: string): void {
  _sessionCostCache.delete(cwd);
  try {
    const path = sessionCostFilePath(cwd);
    if (existsSync(path)) {
      writeFileSync(path, "0", "utf-8");
    }
  } catch {
    // ignore
  }
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function checkCostBudget(config: AutoForkConfig, cwd: string, forkCost: number): { allowed: boolean; reason?: string } {
  const maxForkCost = config.maxForkCost ?? 0;
  const maxSessionCost = config.maxSessionCost ?? 0;
  if (maxForkCost > 0 && forkCost > maxForkCost) {
    return { allowed: false, reason: `fork cost ${formatCost(forkCost)} exceeds maxForkCost ${formatCost(maxForkCost)}` };
  }
  const sessionCost = getSessionForkCost(cwd);
  if (maxSessionCost > 0 && sessionCost + forkCost > maxSessionCost) {
    return { allowed: false, reason: `session cost would reach ${formatCost(sessionCost + forkCost)}, exceeding maxSessionCost ${formatCost(maxSessionCost)}` };
  }
  return { allowed: true };
}

/** Alert level for the current session cost against maxSessionCost. */
export type CostAlertLevel = "ok" | "warning" | "critical";

export interface SessionCostAlert {
  level: CostAlertLevel;
  currentCost: number;
  maxCost: number;
  percent: number;
  message: string;
}

const WARNING_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;

export function checkSessionCostAlert(config: AutoForkConfig, cwd: string): SessionCostAlert | null {
  const maxSessionCost = config.maxSessionCost ?? 0;
  if (maxSessionCost <= 0) return null;
  const currentCost = getSessionForkCost(cwd);
  const percent = currentCost / maxSessionCost;
  if (percent >= CRITICAL_THRESHOLD) {
    return {
      level: "critical",
      currentCost,
      maxCost: maxSessionCost,
      percent,
      message: `cdev session cost ${formatCost(currentCost)} is ${(percent * 100).toFixed(0)}% of budget ${formatCost(maxSessionCost)}`,
    };
  }
  if (percent >= WARNING_THRESHOLD) {
    return {
      level: "warning",
      currentCost,
      maxCost: maxSessionCost,
      percent,
      message: `cdev session cost ${formatCost(currentCost)} is ${(percent * 100).toFixed(0)}% of budget ${formatCost(maxSessionCost)}`,
    };
  }
  return null;
}

export function maybeNotifyCostAlert(ctx: ExtensionContext, config: AutoForkConfig): void {
  const alert = checkSessionCostAlert(config, ctx.cwd);
  if (alert) {
    ctx.ui.notify(alert.message, alert.level === "critical" ? "error" : "warn");
  }
}

// ── Cost estimation ────────────────────────────────────────

const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  // Prices per 1M tokens (USD). Best-effort defaults.
  "deepseek-v4-flash": { input: 0.10, output: 0.30 },
  "deepseek-v4-pro": { input: 3.00, output: 8.00 },
  "kimi-k2-thinking": { input: 0.60, output: 2.40 },
  "kimi-for-coding": { input: 0.30, output: 1.20 },
  "gpt-5-mini": { input: 0.15, output: 0.60 },
  "gpt-5": { input: 2.50, output: 10.00 },
  "claude-sonnet-4-5": { input: 3.00, output: 15.00 },
  "claude-opus-4-5": { input: 15.00, output: 75.00 },
  "gemini-2.0-flash": { input: 0.075, output: 0.30 },
  "gemini-2.5-pro": { input: 1.25, output: 10.00 },
};

function lookupModelPrice(modelId: string): { input: number; output: number } | undefined {
  const normalized = modelId.toLowerCase();
  if (MODEL_PRICES[normalized]) return MODEL_PRICES[normalized];
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (normalized.includes(key) || key.includes(normalized)) return price;
  }
  return undefined;
}

export interface ForkCostEstimateInput {
  task: string;
  stage1Profile: StageProfile;
  stage2Profile: StageProfile;
  quick?: boolean;
  verify?: boolean;
  forkSessionSnapshotJsonl?: string;
}

export interface ForkCostEstimate {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export function estimateForkCost(input: ForkCostEstimateInput): ForkCostEstimate {
  const { task, stage1Profile, stage2Profile, quick = false, verify = false, forkSessionSnapshotJsonl = "" } = input;

  // Base input tokens: task + session snapshot + prompt overhead
  const snapshotChars = forkSessionSnapshotJsonl.length;
  const taskChars = task.length;
  const baseInputChars = snapshotChars + taskChars + 2000;
  const inputTokens = Math.ceil(baseInputChars / 4);

  // Estimated output tokens scales with task complexity
  const outputTokens = Math.min(4000, Math.max(500, Math.ceil(taskChars / 4) + 500));

  const stage1Price = lookupModelPrice(stage1Profile.id);
  const stage2Price = lookupModelPrice(stage2Profile.id);

  const stage1Runs = verify ? 2 : 1;
  const stage1InputCost = stage1Price ? (inputTokens / 1_000_000) * stage1Price.input * stage1Runs : 0;
  const stage1OutputCost = stage1Price ? (outputTokens / 1_000_000) * stage1Price.output * stage1Runs : 0;

  let stage2InputCost = 0;
  let stage2OutputCost = 0;
  if (!quick) {
    const stage2InputTokens = inputTokens + outputTokens; // stage 2 sees stage 1 output too
    stage2InputCost = stage2Price ? (stage2InputTokens / 1_000_000) * stage2Price.input : 0;
    stage2OutputCost = stage2Price ? ((outputTokens * 1.5) / 1_000_000) * stage2Price.output : 0;
  }

  const totalCost = stage1InputCost + stage1OutputCost + stage2InputCost + stage2OutputCost;
  const stage2InputTokens = quick ? 0 : inputTokens + outputTokens;
  const totalInputTokens = Math.ceil(inputTokens * stage1Runs + stage2InputTokens);
  const totalOutputTokens = Math.ceil(outputTokens * stage1Runs + (quick ? 0 : outputTokens * 1.5));

  return {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cost: totalCost,
  };
}

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

function computeCdevVersion(): string {
  let extensionDir: string;
  try {
    extensionDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return "unknown";
  }
  try {
    const git = spawnSync("git", ["describe", "--tags", "--always", "--dirty", "--abbrev=7"], { cwd: extensionDir, timeout: 3000 });
    if (git.status === 0 && git.stdout) return git.stdout.toString().trim();
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: extensionDir, timeout: 3000 });
    if (sha.status === 0 && sha.stdout) return sha.stdout.toString().trim();
  } catch { /* ignore */ }
  try {
    const pkg = JSON.parse(readFileSync(join(extensionDir, "..", "package.json"), "utf-8"));
    if (pkg.version) return pkg.version;
  } catch { /* ignore */ }
  return "unknown";
}

const _cdevVersion = computeCdevVersion();

export function getCdevVersion(_cwd?: string): string {
  return `${_cdevVersion} · ${BUILD_DATE}`;
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

/** Estimate the number of messages in the current Pi session. Read-only. */
export function estimateSessionSize(ctx: ExtensionContext): number {
  try {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    return branch.length + entries.length;
  } catch {
    return 0;
  }
}

const SESSION_SIZE_WARNING_THRESHOLD = 40;

/** Read-only nudge to compact when the parent session is getting large. */
export function maybeWarnSessionSize(ctx: ExtensionContext): void {
  const size = estimateSessionSize(ctx);
  if (size >= SESSION_SIZE_WARNING_THRESHOLD) {
    ctx.ui.notify(
      `Pi session has ~${size} messages. Consider running /compact before the next cdev task.`,
      "warn",
    );
  }
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
    const costInfo = (result.usage?.cost ?? 0) > 0 ? ` — cost: ${formatCost(result.usage?.cost ?? 0)}` : "";
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

export function formatForkResultOutput(result: ForkResult, details: AutoForkDetails): string {
  const stage2Text = getFinalAssistantText(result.messages);
  if (!stage2Text) {
    return formatResultContent(result, details);
  }
  const report = parseStage2Report(stage2Text);
  if (report) {
    return formatStage2Report(report);
  }
  return formatResultContent(result, details);
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
  if (totalCost > 0) segments.push(formatCost(totalCost));
  if (config.promptsEnabled && (config.prompts?.explore || config.prompts?.review)) segments.push("📋");
  if (config.memory) {
    const topicCount = memoryTopicCount(ctx.cwd);
    if (topicCount > 0) segments.push(`🧠 ${topicCount}`);
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
