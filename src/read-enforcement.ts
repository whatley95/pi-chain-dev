/**
 * Redirect direct read tool calls to cdev.
 *
 * When enforceCdevTools is enabled, pi-chain-dev injects a system-prompt rule
 * asking the model to use /cdev read or cdev quick for source-file reads,
 * and blocks direct read calls for source files (with an actionable error).
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

const INJECTION_MARKER = "<!-- pi-chain-dev:enforce-cdev-tools -->";

const PREFER_CDEV_READ_RULE = `
${INJECTION_MARKER}
RULE — prefer cdev for source-file reads, search, discovery, and code analysis:
- For reading source code, verifying current code state, tracing symbols, searching, listing files, or analyzing code structure, use /cdev read <path>[:start-end] or cdev({ quick:true, task: "<describe what you need>" }).
- Do NOT use the direct read, grep, glob, bash, diff, or code-analysis tools for source files, config files, project documents, codebase searches, file discovery, diff reviews, or symbol/AST introspection.
- ESCALATION: If a cdev quick/advisor/research call returns low confidence, missing data, or incomplete findings, you may read up to THREE specific project files directly to verify. After those three reads, go back to using cdev for any broader follow-up.
- CONTROLLED BYPASS: You may also read up to TWO additional source/config files directly per turn when you have a specific, justified reason. To use a bypass, call the read tool with a 'reason' field, for example: read({ path: "src/foo.ts:1-40", reason: "verify cdev findings before editing" }) or read({ path: "src/foo.ts", reason: "need exact line numbers for an edit" }). Repeated reads of the same file are still blocked within one turn.
- COOLDOWN ESCAPE VALVE: If direct reads are blocked several times in a row, a one-time cooldown read will be automatically granted. Use it to get unstuck, then return to /cdev for the rest of the task.
${INJECTION_MARKER}
`.trim();

const SOURCE_LIKE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".rb", ".go", ".rs", ".java", ".kt",
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp",
  ".cs", ".fs", ".fsx", ".swift", ".scala", ".clj",
  ".php", ".pl", ".pm", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql", ".prisma", ".proto",
  ".md", ".mdx", ".json", ".jsonc", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".properties", ".env",
  ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte",
]);

const EXCLUDED_NAMES = new Set([
  "agreement.md", "agents.md", "cla.md", "claude.md", "code_of_conduct.md",
  "contributing.md", "license", "license.md", "notice", "readme", "readme.md",
  "security.md",
]);

interface BeforeAgentStartEventLike {
  systemPrompt: string;
}

interface ReadToolCallEventLike {
  toolName: "read";
  input: { path?: string; file_path?: string; reason?: string; start?: number; end?: number };
}

interface GrepToolCallEventLike {
  toolName: "grep";
  input: { pattern?: string; path?: string; include?: string };
}

interface GlobToolCallEventLike {
  toolName: "glob";
  input: { pattern?: string; path?: string };
}

interface BashToolCallEventLike {
  toolName: "bash";
  input: { command?: string };
}

interface DiffToolCallEventLike {
  toolName: "diff";
  input: { spec?: string; path?: string; file_path?: string };
}

const INTROSPECTION_TOOLS = new Set([
  "typescript",
  "python_ast",
  "python_ast_parse",
  "parse_ast",
  "symbols",
  "trace",
  "analyze",
  "introspect",
  "ast",
  "lsp",
  "tsc",
  "pyright",
  "mypy",
  "eslint",
]);

export function getPreferCdevReadRule(): string {
  return PREFER_CDEV_READ_RULE;
}

function looksLikeSourceFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (EXCLUDED_NAMES.has(base)) return false;
  const ext = path.extname(base);
  if (!ext) {
    // Treat extension-less files in project dirs as source/config (e.g. Makefile, Dockerfile).
    return true;
  }
  return SOURCE_LIKE_EXTENSIONS.has(ext);
}

const MAX_CONTROLLED_BYPASS_READS_PER_TURN = 2;

function isJustifiedBypassReason(reason: string | undefined): boolean {
  if (!reason || typeof reason !== "string") return false;
  const trimmed = reason.trim();
  if (trimmed.length < 8) return false;
  const lower = trimmed.toLowerCase();
  const genericFiller = new Set(["read", "want", "need", "file", "check", "see", "look"]);
  const meaningfulWords = lower.split(/\s+/).filter((w) => w.length > 0 && !genericFiller.has(w));
  if (meaningfulWords.length < 2) return false;
  const redFlags = ["ignore", "bypass", "disable guard", "loophole"];
  if (redFlags.some((flag) => lower.includes(flag))) return false;
  return true;
}

function isSmallSnippet(start: unknown, end: unknown): boolean {
  if (typeof start !== "number" || typeof end !== "number") return false;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 1 || end < start) return false;
  return end - start + 1 <= 30;
}

function formatBlockReason(filePath: string, bypassRemaining: number, escalationRemaining: number): string {
  let msg = `Direct read is disabled for source/config files. Use /cdev read ${filePath} or cdev({ quick:true, task: "read ${filePath}" }) instead.`;
  if (escalationRemaining > 0) {
    msg += ` You have ${escalationRemaining} escalation read(s) left from the last low-confidence cdev result.`;
  }
  if (bypassRemaining > 0) {
    msg += ` Or use a controlled bypass: read({ path: "${filePath}", reason: "<concrete justification>" }). You have ${bypassRemaining} bypass read(s) left this turn.`;
  }
  return msg;
}

function formatGrepBlockReason(pattern: string, scope: string): string {
  return `Direct grep is disabled for source/config searches. Use cdev({ quick:true, task: "search for '${pattern}'${scope ? ' in ' + scope : ''}" }) instead.`;
}

function formatGlobBlockReason(pattern: string): string {
  return `Direct glob is disabled for source/config patterns. Use cdev({ quick:true, task: "list files matching '${pattern}'" }) instead.`;
}

function formatBashBlockReason(command: string): string {
  return `Direct bash '${command}' is disabled for file reads and discovery. Use cdev({ quick:true, task: "${command}" }) instead.`;
}

function formatDiffBlockReason(spec: string): string {
  return `Direct diff is disabled for code reviews. Use /cdev review ${spec} or cdev({ review:true, diffSpec:"${spec}" }) instead.`;
}

function formatIntrospectionBlockReason(toolName: string): string {
  return `Direct '${toolName}' is disabled for code analysis. Use cdev({ quick:true, task: "analyze code with ${toolName}" }) instead.`;
}

function formatRepeatedReadReason(filePath: string): string {
  return `Direct read of ${filePath} was already used this turn. Stop re-reading the same file; use the content you already have or run cdev({ quick:true, task: "summarize/reconcile ${filePath}" }) if needed.`;
}

function isProjectPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("/") || normalized.startsWith("~") || /^[a-z]:/.test(normalized)) {
    return false;
  }
  return true;
}

function extractProjectPathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "file", "paths", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value) {
      return value;
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
      return value[0];
    }
  }
  return undefined;
}

function isIntrospectionTool(toolName: string): boolean {
  return INTROSPECTION_TOOLS.has(toolName.toLowerCase());
}

function looksLikeSourcePattern(filePath: string): boolean {
  if (!filePath) return true;
  if (!isProjectPath(filePath)) return false;
  const lower = filePath.toLowerCase();
  if (lower.includes("node_modules") || lower.includes(".git/") || lower.includes(".pi/")) {
    return false;
  }
  const globSuffix = lower.split("/").pop() ?? "";
  if (globSuffix.includes("*")) {
    const ext = path.extname(globSuffix);
    return !ext || SOURCE_LIKE_EXTENSIONS.has(ext);
  }
  return looksLikeSourceFile(filePath);
}

const BASH_READ_COMMANDS = [
  "cat ",
  "head ",
  "tail ",
  "less ",
  "more ",
  "grep ",
  "rg ",
  "find ",
  "git ls-files",
  "git diff",
  "ls -r ",
  "ls -la ",
  "ls -l ",
];

function isReadLikeBashCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith("cd ") || trimmed.startsWith("pwd") || trimmed.startsWith("echo ")) {
    return false;
  }
  return BASH_READ_COMMANDS.some((prefix) => trimmed.startsWith(prefix));
}

function looksLikeSourceBashCommand(command: string): boolean {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  if (lower.includes("node_modules") || lower.includes(".git/") || lower.includes("/.pi/")) {
    return false;
  }
  if (/\b(?:cat|head|tail|less|more)\s+['"]?([a-z]:\/|\/|~)/i.test(trimmed)) {
    return false;
  }
  return true;
}

interface GenericToolCallEventLike {
  toolName: string;
  input: Record<string, unknown>;
}

interface CdevQualitySignal {
  groundingScore?: number;
  qualityScore?: number;
  ungroundedClaimCount?: number;
  actionItemCount?: number;
  hasFindings: boolean;
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;

function isLowConfidence(signal: CdevQualitySignal): boolean {
  if (!signal.hasFindings) return true;
  if (signal.qualityScore !== undefined && signal.qualityScore < LOW_CONFIDENCE_THRESHOLD) return true;
  if (signal.groundingScore !== undefined && signal.groundingScore < LOW_CONFIDENCE_THRESHOLD) return true;
  if (signal.ungroundedClaimCount !== undefined && signal.ungroundedClaimCount > 0) return true;
  return false;
}

function extractCdevQualitySignal(details: unknown): CdevQualitySignal | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const ui = d.ui as Record<string, unknown> | undefined;
  const hasFindings =
    typeof ui?.actionItemCount === "number" && ui.actionItemCount > 0
      ? true
      : Array.isArray(d.findings) && d.findings.length > 0;

  const signal: CdevQualitySignal = {
    hasFindings: Boolean(hasFindings),
    groundingScore: typeof ui?.groundingScore === "number" ? ui.groundingScore : undefined,
    qualityScore: typeof ui?.qualityScore === "number" ? ui.qualityScore : undefined,
    ungroundedClaimCount: typeof ui?.ungroundedClaimCount === "number" ? ui.ungroundedClaimCount : undefined,
    actionItemCount: typeof ui?.actionItemCount === "number" ? ui.actionItemCount : undefined,
  };
  return signal;
}

type ToolCallEventLike =
  | ReadToolCallEventLike
  | GrepToolCallEventLike
  | GlobToolCallEventLike
  | BashToolCallEventLike
  | DiffToolCallEventLike
  | GenericToolCallEventLike;

export function registerReadEnforcement(pi: ExtensionAPI): void {
  const readPathsThisTurn = new Set<string>();
  let readEscalationRemaining = 0;
  let controlledBypassRemaining = MAX_CONTROLLED_BYPASS_READS_PER_TURN;
  let consecutiveBlocks = 0;
  let cooldownActive = false;

  function resetCooldown(): void {
    consecutiveBlocks = 0;
    cooldownActive = false;
  }

  function sendSteer(message: string): void {
    try {
      pi.sendUserMessage?.(message, { deliverAs: "steer" });
    } catch {
      // best-effort steer
    }
  }

  pi.on("turn_start", async () => {
    readPathsThisTurn.clear();
    readEscalationRemaining = 0;
    controlledBypassRemaining = MAX_CONTROLLED_BYPASS_READS_PER_TURN;
  });

  pi.on("tool_result", (_event, ctx: ExtensionContext) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enforceCdevTools) return undefined;
    const toolResult = _event as { toolName?: string; result?: unknown } | undefined;
    if (toolResult?.toolName === "cdev") {
      resetCooldown();
      if (!config.allowCdevReadEscalation) return undefined;
      const signal = extractCdevQualitySignal(toolResult.result);
      if (signal && isLowConfidence(signal)) {
        readEscalationRemaining = Math.max(readEscalationRemaining, 3);
      }
    }
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enforceCdevTools) return undefined;
    const beforeEvent = event as BeforeAgentStartEventLike;
    if (!beforeEvent.systemPrompt.includes(INJECTION_MARKER)) {
      beforeEvent.systemPrompt += `\n\n${PREFER_CDEV_READ_RULE}`;
    }
    return { systemPrompt: beforeEvent.systemPrompt };
  });

  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enforceCdevTools) return undefined;
    const cooldownThreshold = config.cdevReadCooldownAfterBlocks ?? 3;
    const toolEvent = event as ToolCallEventLike;
    if (toolEvent.toolName === "read") {
      const rawPath = (toolEvent.input.path ?? toolEvent.input.file_path) as string | undefined;
      if (!rawPath) return undefined;
      if (readPathsThisTurn.has(rawPath)) {
        return { block: true, reason: formatRepeatedReadReason(rawPath) };
      }
      if (!looksLikeSourceFile(rawPath)) return undefined;
      if (cooldownActive && cooldownThreshold > 0) {
        cooldownActive = false;
        consecutiveBlocks = 0;
        readPathsThisTurn.add(rawPath);
        sendSteer(`Cooldown read used on ${rawPath}. Enforcement is back on — use /cdev read or cdev({ quick:true }) for further discovery.`);
        return undefined;
      }
      if (readEscalationRemaining > 0 && config.allowCdevReadEscalation) {
        readEscalationRemaining--;
        readPathsThisTurn.add(rawPath);
        return undefined;
      }
      if (isSmallSnippet(toolEvent.input.start, toolEvent.input.end)) {
        readPathsThisTurn.add(rawPath);
        return undefined;
      }
      if (controlledBypassRemaining > 0 && isJustifiedBypassReason(toolEvent.input.reason as string | undefined)) {
        controlledBypassRemaining--;
        readPathsThisTurn.add(rawPath);
        return undefined;
      }
      readPathsThisTurn.add(rawPath);
      if (cooldownThreshold > 0) {
        consecutiveBlocks++;
        if (consecutiveBlocks >= cooldownThreshold) {
          cooldownActive = true;
          sendSteer(`Read-enforcement cooldown triggered after ${consecutiveBlocks} blocked direct reads. Your next direct project-file read will be allowed as a one-time escape valve — use it wisely, then return to /cdev.`);
        }
      }
      return { block: true, reason: formatBlockReason(rawPath, controlledBypassRemaining, readEscalationRemaining) };
    }
    if (toolEvent.toolName === "grep") {
      const pattern = (toolEvent.input.pattern ?? "") as string;
      const searchPath = (toolEvent.input.path ?? "") as string;
      const include = (toolEvent.input.include ?? "") as string;
      if (!pattern) return undefined;
      const effectivePath = searchPath || include;
      if (effectivePath && !looksLikeSourcePattern(effectivePath)) return undefined;
      const scope = searchPath ? searchPath : include ? `files matching ${include}` : "";
      if (cooldownThreshold > 0) consecutiveBlocks++;
      return { block: true, reason: formatGrepBlockReason(pattern, scope) };
    }
    if (toolEvent.toolName === "glob") {
      const pattern = (toolEvent.input.pattern ?? "") as string;
      if (!pattern) return undefined;
      if (!looksLikeSourcePattern(pattern)) return undefined;
      if (cooldownThreshold > 0) consecutiveBlocks++;
      return { block: true, reason: formatGlobBlockReason(pattern) };
    }
    if (toolEvent.toolName === "bash") {
      const command = (toolEvent.input.command ?? "") as string;
      if (!command) return undefined;
      if (!isReadLikeBashCommand(command)) return undefined;
      if (!looksLikeSourceBashCommand(command)) return undefined;
      if (cooldownThreshold > 0) consecutiveBlocks++;
      return { block: true, reason: formatBashBlockReason(command.trim()) };
    }
    if (toolEvent.toolName === "diff") {
      const spec = ((toolEvent.input.spec ?? toolEvent.input.path ?? toolEvent.input.file_path) ?? "") as string;
      if (!spec) return undefined;
      if (cooldownThreshold > 0) consecutiveBlocks++;
      return { block: true, reason: formatDiffBlockReason(spec) };
    }
    if (isIntrospectionTool(String(toolEvent.toolName))) {
      const args = toolEvent.input as Record<string, unknown>;
      const targetPath = extractProjectPathFromArgs(args);
      if (targetPath && !looksLikeSourcePattern(targetPath)) return undefined;
      if (cooldownThreshold > 0) consecutiveBlocks++;
      return { block: true, reason: formatIntrospectionBlockReason(String(toolEvent.toolName)) };
    }
    return undefined;
  });
}

export function shouldBlockRead(filePath: string): { block: true; reason: string } | undefined {
  if (!looksLikeSourceFile(filePath)) return undefined;
  return { block: true, reason: formatBlockReason(filePath, MAX_CONTROLLED_BYPASS_READS_PER_TURN, 0) };
}

export function shouldBlockGrep(pattern: string, filePath: string, include?: string): { block: true; reason: string } | undefined {
  const effectivePath = filePath || include || "";
  if (effectivePath && !looksLikeSourcePattern(effectivePath)) return undefined;
  const scope = filePath ? filePath : include ? `files matching ${include}` : "";
  return { block: true, reason: formatGrepBlockReason(pattern, scope) };
}

export function shouldBlockGlob(pattern: string): { block: true; reason: string } | undefined {
  if (!looksLikeSourcePattern(pattern)) return undefined;
  return { block: true, reason: formatGlobBlockReason(pattern) };
}

export function shouldBlockDiff(spec: string): { block: true; reason: string } | undefined {
  if (!spec) return undefined;
  return { block: true, reason: formatDiffBlockReason(spec) };
}

export function shouldBlockRepeatedRead(filePath: string, seenThisTurn: Set<string>): { block: true; reason: string } | undefined {
  if (!seenThisTurn.has(filePath)) return undefined;
  return { block: true, reason: formatRepeatedReadReason(filePath) };
}

export function shouldBlockIntrospection(toolName: string, args: Record<string, unknown> = {}): { block: true; reason: string } | undefined {
  if (!isIntrospectionTool(toolName)) return undefined;
  const targetPath = extractProjectPathFromArgs(args);
  if (targetPath && !looksLikeSourcePattern(targetPath)) return undefined;
  return { block: true, reason: formatIntrospectionBlockReason(toolName) };
}

export function shouldBlockBash(command: string): { block: true; reason: string } | undefined {
  if (!isReadLikeBashCommand(command)) return undefined;
  if (!looksLikeSourceBashCommand(command)) return undefined;
  return { block: true, reason: formatBashBlockReason(command.trim()) };
}
