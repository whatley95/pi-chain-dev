/**
 * gatherCodeContext: fast read-only code context collection for scouts.
 *
 * This tool combines discovery and snippet reads into one round-trip:
 * rg/search -> rank files -> return compact line-window snippets.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPathUnderCwd } from "./path-guards.js";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_FILES = 20;
const MAX_CONTEXT_LINES = 20;
const MAX_MATCHES = 80;
const MAX_OUTPUT_CHARS = 60_000;
const FALLBACK_MAX_FILES_SCANNED = 2000;
const FALLBACK_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 32 MB read budget when rg is unavailable

const SKIP_DIRS = new Set([
  ".git",
  ".pi",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "target",
  ".gradle",
  ".dart_tool",
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".go",
  ".gradle",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

export const gatherCodeContextSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query or regex to find relevant code.",
    },
    paths: {
      type: "array",
      description: "Optional relative paths/directories to search. Defaults to project root.",
      items: { type: "string" },
    },
    maxFiles: {
      type: "integer",
      description: `Maximum ranked files to return, 1-${MAX_FILES}. Default ${DEFAULT_MAX_FILES}.`,
    },
    contextLines: {
      type: "integer",
      description: `Lines before/after each match, 0-${MAX_CONTEXT_LINES}. Default ${DEFAULT_CONTEXT_LINES}.`,
    },
    literal: {
      type: "boolean",
      description: "Treat query as a literal string instead of a regex.",
    },
  },
  required: ["query"],
};

export interface GatherCodeContextInput {
  query: string;
  paths?: string[];
  maxFiles?: number;
  contextLines?: number;
  literal?: boolean;
}

interface Match {
  file: string;
  line: number;
  text: string;
}

interface GatheredFile {
  file: string;
  matches: Match[];
  snippets: string[];
}

export interface GatherCodeContextResult {
  query: string;
  files: GatheredFile[];
  totalMatches: number;
  truncated: boolean;
  usedFallback: boolean;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function displayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizeSearchPaths(cwd: string, paths: unknown): string[] {
  const rawPaths = Array.isArray(paths) ? paths : ["."];
  const normalized: string[] = [];
  for (const raw of rawPaths) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = resolve(cwd, raw);
    if (!isPathUnderCwd(cwd, abs) && relative(resolve(cwd), abs) !== "") continue;
    normalized.push(relative(cwd, abs) || ".");
  }
  return normalized.length > 0 ? [...new Set(normalized)] : ["."];
}

function parseRgLine(line: string): Match | null {
  const match = line.match(/^(.*?):(\d+):(.*)$/);
  if (!match) return null;
  const lineNo = Number.parseInt(match[2], 10);
  if (!Number.isFinite(lineNo)) return null;
  return { file: match[1], line: lineNo, text: match[3] };
}

function runRg(cwd: string, input: GatherCodeContextInput, paths: string[]): Match[] | null {
  const args = ["-n", "--no-heading", "--color", "never", "--glob", "!{node_modules,.git,.pi,dist,build,.next,.turbo,coverage,target}/**"];
  if (input.literal !== false) args.push("-F");
  args.push("--", input.query, ...paths);
  const result = spawnSync("rg", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return null;
  if (result.status !== 0 && !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseRgLine)
    .filter((match): match is Match => match !== null)
    .slice(0, MAX_MATCHES);
}

function isLikelyTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const base = filePath.split(/[\\/]/).pop() ?? "";
  return ["Dockerfile", "Makefile", "pom.xml", "package.json", "tsconfig.json"].includes(base);
}

function listFallbackFiles(cwd: string, paths: string[]): string[] {
  const files: string[] = [];
  let totalBytes = 0;
  const visit = (abs: string) => {
    if (files.length >= FALLBACK_MAX_FILES_SCANNED || totalBytes >= FALLBACK_MAX_TOTAL_BYTES) return;
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      const name = abs.split(/[\\/]/).pop() ?? "";
      if (SKIP_DIRS.has(name)) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (!stats.isFile() || stats.size > 512_000 || !isLikelyTextFile(abs)) return;
    files.push(abs);
    totalBytes += stats.size;
  };
  for (const relPath of paths) visit(resolve(cwd, relPath));
  return files;
}

function fallbackSearch(cwd: string, input: GatherCodeContextInput, paths: string[]): Match[] {
  const query = input.query;
  const literal = input.literal !== false;
  let regex: RegExp | null = null;
  if (!literal) {
    try {
      regex = new RegExp(query, "i");
    } catch {
      return [];
    }
  }
  const matches: Match[] = [];
  let scannedBytes = 0;
  for (const abs of listFallbackFiles(cwd, paths)) {
    if (matches.length >= MAX_MATCHES) break;
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    scannedBytes += Buffer.byteLength(content, "utf-8");
    if (scannedBytes > FALLBACK_MAX_TOTAL_BYTES) break;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      const line = lines[i];
      const hit = literal ? line.includes(query) : regex?.test(line);
      if (hit) {
        matches.push({ file: displayPath(relative(cwd, abs)), line: i + 1, text: line });
      }
    }
  }
  return matches;
}

function mergeWindows(lines: string[], matchLines: number[], contextLines: number): Array<[number, number]> {
  const windows = matchLines
    .map((line) => [Math.max(1, line - contextLines), Math.min(lines.length, line + contextLines)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const win of windows) {
    const last = merged[merged.length - 1];
    if (last && win[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], win[1]);
    } else {
      merged.push([...win]);
    }
  }
  return merged;
}

function buildSnippet(cwd: string, file: string, matchLines: number[], contextLines: number): string[] {
  const abs = resolve(cwd, file);
  if (!isPathUnderCwd(cwd, abs) || !existsSync(abs)) return [];
  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  return mergeWindows(lines, matchLines, contextLines).map(([start, end]) => {
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}: ${line}`)
      .join("\n");
    return `--- ${file}:${start}-${end} ---\n${body}`;
  });
}

export function gatherCodeContext(cwd: string, input: GatherCodeContextInput): GatherCodeContextResult {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return { query, files: [], totalMatches: 0, truncated: false, usedFallback: false };
  }

  const maxFiles = clampInt(input.maxFiles, DEFAULT_MAX_FILES, 1, MAX_FILES);
  const contextLines = clampInt(input.contextLines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
  const paths = normalizeSearchPaths(cwd, input.paths);
  let usedFallback = false;
  let matches = runRg(cwd, { ...input, query }, paths);
  if (matches === null) {
    usedFallback = true;
    matches = fallbackSearch(cwd, { ...input, query }, paths);
  }

  const byFile = new Map<string, Match[]>();
  for (const match of matches) {
    const abs = resolve(cwd, match.file);
    if (!isPathUnderCwd(cwd, abs)) continue;
    const relPath = displayPath(relative(cwd, abs));
    const list = byFile.get(relPath) ?? [];
    list.push({ ...match, file: relPath });
    byFile.set(relPath, list);
  }

  const files: GatheredFile[] = [...byFile.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxFiles)
    .map(([file, fileMatches]) => ({
      file,
      matches: fileMatches,
      snippets: buildSnippet(cwd, file, fileMatches.map((m) => m.line), contextLines),
    }));

  return {
    query,
    files,
    totalMatches: matches.length,
    truncated: matches.length >= MAX_MATCHES,
    usedFallback,
  };
}

export function formatGatherCodeContextResult(result: GatherCodeContextResult): string {
  if (!result.query) return "gatherCodeContext error: query is required.";
  if (result.files.length === 0) {
    return `No matches found for "${result.query}".${result.usedFallback ? " (rg unavailable; used JS fallback)" : ""}`;
  }
  const lines: string[] = [
    `gatherCodeContext: "${result.query}"`,
    `Matches: ${result.totalMatches}${result.truncated ? "+" : ""} across ${result.files.length} ranked file(s)${result.usedFallback ? " (rg fallback)" : ""}`,
    "",
  ];
  let total = lines.join("\n").length;
  for (const file of result.files) {
    const header = `## ${file.file} (${file.matches.length} match${file.matches.length === 1 ? "" : "es"})`;
    const chunk = [header, ...file.snippets].join("\n\n");
    if (total + chunk.length > MAX_OUTPUT_CHARS) {
      lines.push("... output truncated; lower maxFiles/contextLines or narrow paths.");
      break;
    }
    lines.push(chunk, "");
    total += chunk.length + 2;
  }
  return lines.join("\n").trimEnd();
}

export function registerGatherCodeContextTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gatherCodeContext",
    label: "Gather Code Context",
    description:
      "Read-only scout helper that searches with rg, ranks matching files, and returns compact line-window snippets in one tool call.",
    promptSnippet: "gatherCodeContext: search and read compact snippets in one call",
    promptGuidelines: [
      "Use gatherCodeContext before separate rg + read loops when you need code context for a query.",
      "Keep paths narrow when the task names a directory or module.",
      "Use multiRead after gatherCodeContext only when you need full-file context.",
    ],
    parameters: gatherCodeContextSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Aborted" }],
          details: { count: 0 },
        };
      }
      const input = params as unknown as GatherCodeContextInput;
      const result = gatherCodeContext(ctx.cwd, input);
      return {
        content: [{ type: "text" as const, text: formatGatherCodeContextResult(result) }],
        details: {
          count: result.files.length,
          totalMatches: result.totalMatches,
          truncated: result.truncated,
          usedFallback: result.usedFallback,
        },
      };
    },
  });
}
