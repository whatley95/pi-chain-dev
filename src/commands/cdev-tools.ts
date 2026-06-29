import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gatherCodeContext, formatGatherCodeContextResult } from "../gather-code-context.js";
import { isPathUnderCwd } from "../path-guards.js";
import { loadProjectMap } from "../project-map.js";
import { safeDisplayText } from "../text-width.js";

interface ReadTarget {
  path: string;
  start?: number;
  end?: number;
}

const MAX_DIRECT_READ_CHARS = 60_000;
const MAX_DIRECT_READ_FILES = 10;

const MAX_NOTIFY_CHARS = 60_000;

function notifyInfo(ctx: ExtensionContext, text: string): void {
  const truncated = text.length > MAX_NOTIFY_CHARS
    ? text.slice(0, MAX_NOTIFY_CHARS) + "\n\n... (truncated)"
    : text;
  ctx.ui.notify(safeDisplayText(truncated), "info");
}

function parseReadTarget(raw: string): ReadTarget {
  const match = raw.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: raw };
  const start = Number.parseInt(match[2], 10);
  const end = match[3] ? Number.parseInt(match[3], 10) : start;
  return {
    path: match[1],
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
  };
}

function readDirectFile(cwd: string, target: ReadTarget): string {
  const abs = resolve(cwd, target.path);
  if (!isPathUnderCwd(cwd, abs)) return `## ${target.path}\nERROR: path is outside the workspace.`;
  if (!existsSync(abs)) return `## ${target.path}\nERROR: file not found.`;
  const stats = statSync(abs);
  if (!stats.isFile()) return `## ${target.path}\nERROR: not a regular file.`;
  if (stats.size > 2 * 1024 * 1024) return `## ${target.path}\nERROR: file is too large for direct read.`;

  const content = readFileSync(abs, "utf-8");
  const lines = content.split(/\r?\n/);
  const start = target.start && target.start > 0 ? target.start : 1;
  const end = target.end && target.end >= start ? Math.min(target.end, lines.length) : lines.length;
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}: ${line}`)
    .join("\n");
  return `## ${target.path}${target.start ? `:${start}-${end}` : ""}\n${body}`;
}

function formatDirectRead(cwd: string, rawTargets: string): string {
  const targets = rawTargets
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_DIRECT_READ_FILES)
    .map(parseReadTarget);
  if (targets.length === 0) return "Usage: /cdev read <path[:start-end]> [more paths...]";

  const chunks: string[] = ["cdev direct read (no scout model)\n"];
  let total = chunks.join("\n").length;
  for (const target of targets) {
    const chunk = readDirectFile(cwd, target);
    if (total + chunk.length > MAX_DIRECT_READ_CHARS) {
      chunks.push("... output truncated. Use narrower line ranges.");
      break;
    }
    chunks.push(chunk);
    total += chunk.length + 2;
  }
  return chunks.join("\n\n");
}

function parseQueryAndPaths(raw: string): { query: string; paths: string[] } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { query: "", paths: [] };
  const query = parts[0];
  const paths = parts.slice(1);
  return { query, paths };
}

function symbolIndexMatches(cwd: string, symbol: string): string {
  const map = loadProjectMap(cwd);
  if (!map) return "";
  const needle = symbol.toLowerCase();
  const definingFiles: string[] = [];
  for (const [file, exports] of Object.entries(map.files.fileExports)) {
    if (exports.some((name) => name.toLowerCase() === needle || name.toLowerCase().includes(needle))) {
      definingFiles.push(file);
    }
  }
  if (definingFiles.length === 0) return "";

  const importUsers: string[] = [];
  for (const [file, imports] of Object.entries(map.files.fileImports)) {
    if (imports.some((item) => item.toLowerCase().includes(needle))) {
      importUsers.push(file);
    }
  }

  const lines = [
    "## Symbol index",
    `Definition/export candidates: ${definingFiles.slice(0, 10).join(", ")}`,
  ];
  if (importUsers.length > 0) {
    lines.push(`Import/user candidates: ${importUsers.slice(0, 10).join(", ")}`);
  }
  return lines.join("\n");
}

function isLikelyPath(target: string): boolean {
  return /[\\/]/.test(target) || extname(target).length > 0;
}

export async function handleReadSubcommand(trimmed: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<boolean> {
  const m = trimmed.match(/^read\s+(.+)$/i);
  if (!m) return false;
  notifyInfo(ctx, formatDirectRead(ctx.cwd, m[1]));
  return true;
}

export async function handleGrepSubcommand(trimmed: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<boolean> {
  const m = trimmed.match(/^grep\s+(.+)$/i);
  if (!m) return false;
  const { query, paths } = parseQueryAndPaths(m[1]);
  const result = gatherCodeContext(ctx.cwd, {
    query,
    paths: paths.length ? paths : undefined,
    maxFiles: 12,
    contextLines: 2,
  });
  notifyInfo(ctx, `cdev direct grep (no scout model)\n\n${formatGatherCodeContextResult(result)}`);
  return true;
}

export async function handleTraceSubcommand(trimmed: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<boolean> {
  const m = trimmed.match(/^trace\s+(.+)$/i);
  if (!m) return false;
  const symbol = m[1].trim();
  const index = symbolIndexMatches(ctx.cwd, symbol);
  const result = gatherCodeContext(ctx.cwd, {
    query: symbol,
    maxFiles: 12,
    contextLines: 3,
  });
  notifyInfo(ctx, [
    "cdev direct trace (no scout model)",
    index,
    formatGatherCodeContextResult(result),
  ].filter(Boolean).join("\n\n"));
  return true;
}

export async function handleExplainSubcommand(trimmed: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<boolean> {
  const m = trimmed.match(/^explain\s+(.+)$/i);
  if (!m) return false;
  const target = m[1].trim();
  if (isLikelyPath(target)) {
    notifyInfo(ctx, formatDirectRead(ctx.cwd, target));
    return true;
  }
  const index = symbolIndexMatches(ctx.cwd, target);
  const result = gatherCodeContext(ctx.cwd, {
    query: target,
    maxFiles: 8,
    contextLines: 4,
  });
  notifyInfo(ctx, [
    "cdev direct explain (no scout model)",
    index,
    formatGatherCodeContextResult(result),
  ].filter(Boolean).join("\n\n"));
  return true;
}
