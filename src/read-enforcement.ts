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
RULE — prefer cdev for source-file reads, search, and discovery:
- For reading source code, verifying current code state, tracing symbols, searching, or listing files, use /cdev read <path>[:start-end] or cdev({ quick:true, task: "<describe what you need>" }).
- Do NOT use the direct read, grep, glob, or bash tools for source files, config files, project documents, codebase searches, or file discovery.
- Only use direct read for tiny snippets (under ~30 lines) when cdev is unavailable, or for binary/image files, external documentation, or files outside the project.
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
  input: { path?: string; file_path?: string };
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

function formatBlockReason(filePath: string): string {
  return `Direct read is disabled for source/config files. Use /cdev read ${filePath} or cdev({ quick:true, task: "read ${filePath}" }) instead.`;
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

function isProjectPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("/") || normalized.startsWith("~") || /^[a-z]:/.test(normalized)) {
    return false;
  }
  return true;
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

export function registerReadEnforcement(pi: ExtensionAPI): void {
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
    const toolEvent = event as ReadToolCallEventLike | GrepToolCallEventLike | GlobToolCallEventLike | BashToolCallEventLike;
    if (toolEvent.toolName === "read") {
      const rawPath = toolEvent.input.path ?? toolEvent.input.file_path;
      if (!rawPath) return undefined;
      if (!looksLikeSourceFile(rawPath)) return undefined;
      return { block: true, reason: formatBlockReason(rawPath) };
    }
    if (toolEvent.toolName === "grep") {
      const pattern = toolEvent.input.pattern ?? "";
      const searchPath = toolEvent.input.path ?? "";
      const include = toolEvent.input.include ?? "";
      if (!pattern) return undefined;
      const effectivePath = searchPath || include;
      if (effectivePath && !looksLikeSourcePattern(effectivePath)) return undefined;
      const scope = searchPath ? searchPath : include ? `files matching ${include}` : "";
      return { block: true, reason: formatGrepBlockReason(pattern, scope) };
    }
    if (toolEvent.toolName === "glob") {
      const pattern = toolEvent.input.pattern ?? "";
      if (!pattern) return undefined;
      if (!looksLikeSourcePattern(pattern)) return undefined;
      return { block: true, reason: formatGlobBlockReason(pattern) };
    }
    if (toolEvent.toolName === "bash") {
      const command = toolEvent.input.command ?? "";
      if (!command) return undefined;
      if (!isReadLikeBashCommand(command)) return undefined;
      if (!looksLikeSourceBashCommand(command)) return undefined;
      return { block: true, reason: formatBashBlockReason(command.trim()) };
    }
    return undefined;
  });
}

export function shouldBlockRead(filePath: string): { block: true; reason: string } | undefined {
  if (!looksLikeSourceFile(filePath)) return undefined;
  return { block: true, reason: formatBlockReason(filePath) };
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

export function shouldBlockBash(command: string): { block: true; reason: string } | undefined {
  if (!isReadLikeBashCommand(command)) return undefined;
  if (!looksLikeSourceBashCommand(command)) return undefined;
  return { block: true, reason: formatBashBlockReason(command.trim()) };
}
