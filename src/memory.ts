/**
 * Project-level cdev memory — cross-session knowledge base.
 *
 * Stores fork findings keyed by topic in .pi/cdev/memory.json.
 * Uses file fingerprinting (SHA256) for staleness detection.
 * Survives session deletion, persists across sessions.
 *
 * Commands:
 *   /cdev recall [topic]  — view findings, auto-check freshness
 *   /cdev memory clear     — wipe all memory
 *   /cdev memory forget <topic> — remove a topic
 *   /cdev memory refresh <topic> — re-explore a topic and update findings
 *   /cdev clear            — alias for memory clear
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { CdevMemory, CdevTopic, CdevFindingRecord } from "./types.js";
import { PROMPT_VERSION } from "./prompt-version.js";
import { formatCost } from "./extension-context.js";
import { logWarn, logError } from "./logger.js";
import { isPathUnderCwd } from "./path-guards.js";

// ── Storage ──────────────────────────────────────────────

function getMemoryPath(cwd: string): string {
  return join(cwd, ".pi", "cdev", "memory.json");
}

function ensureDir(cwd: string): void {
  const dir = join(cwd, ".pi", "cdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isValidFinding(value: unknown): value is CdevFindingRecord {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.text !== "string") return false;
  if (typeof f.timestamp !== "number") return false;
  if (typeof f.stage !== "string" || !["stage1", "stage2", "review"].includes(f.stage)) return false;
  if (typeof f.models !== "string") return false;
  if (typeof f.cost !== "number") return false;
  if (f.promptVersion !== undefined && typeof f.promptVersion !== "string") return false;
  if (f.fileFingerprints !== undefined) {
    if (typeof f.fileFingerprints !== "object" || f.fileFingerprints === null) return false;
    for (const v of Object.values(f.fileFingerprints)) {
      if (typeof v !== "string") return false;
    }
  }
  return true;
}

function isValidTopic(value: unknown): value is CdevTopic {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  if (typeof t.name !== "string") return false;
  if (!Array.isArray(t.findings)) return false;
  for (const f of t.findings) {
    if (!isValidFinding(f)) return false;
  }
  if (typeof t.forkCount !== "number") return false;
  if (typeof t.firstSeen !== "number") return false;
  if (typeof t.lastSeen !== "number") return false;
  if (!Array.isArray(t.files)) return false;
  for (const f of t.files) {
    if (typeof f !== "string") return false;
  }
  return true;
}

function isValidMemory(value: unknown): value is CdevMemory {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.version !== 1) return false;
  if (typeof m.topics !== "object" || m.topics === null) return false;
  for (const topic of Object.values(m.topics)) {
    if (!isValidTopic(topic)) return false;
  }
  return true;
}

export function loadMemory(cwd: string): CdevMemory {
  const path = getMemoryPath(cwd);
  if (!existsSync(path)) return { version: 1, topics: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (isValidMemory(raw)) return raw;
    logWarn(cwd, "loadMemory", "memory.json had unexpected shape; starting fresh");
    return { version: 1, topics: {} };
  } catch (err) {
    logError(cwd, "loadMemory", err, { path });
    return { version: 1, topics: {} };
  }
}

function saveMemory(cwd: string, memory: CdevMemory): void {
  ensureDir(cwd);
  const path = getMemoryPath(cwd);
  const content = JSON.stringify(memory, null, 2) + "\n";
  try {
    writeFileSync(path, content, "utf-8");
  } catch (err) {
    logError(cwd, "saveMemory", err, { path });
  }
  _topicCountCache = null;
}

// ── File fingerprinting ──────────────────────────────────

function fileFingerprint(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

export function extractFilePaths(text: string, cwd: string): string[] {
  // Multiple patterns to catch different path representations.
  // Each pattern's LAST capture group must be the path; the second-to-last (if present)
  // is an optional prefix like ./ or ../. Keep this invariant when adding patterns.
  const MAX_MATCHES = 100;
  const patterns = [
    // Explicit paths: src/foo/bar.ts, app/models/user.rb
    /(?:^|\s|[`'"([{<])(\.{0,2}[/\\])?((?:[\w@.-]+[/\\]){1,6}[\w@.-]+\.\w{1,8})(?=[:"',)}\]><\s]|$)/gm,
    // Paths after common markers: "in file X", "at path X", "the file X"
    /(?:file|path|module|package|class)\s+[`'" ]?(\.{0,2}[/\\])?((?:[\w@.-]+[/\\]){1,6}[\w@.-]+\.\w{1,8})[`'" ]?(?=["',)\]>.\s]|$)/gi,
    // Backtick-enclosed paths with directory or bare filename: `src/foo/bar.ts`, `config.ts`
    /`((?:[\w@.-]+[/\\]){0,6}[\w@.-]+\.\w{1,8})`/g,
    // Double-quoted paths: "path/to/file.ts"
    /"((?:[\w@.-]+[/\\]){1,6}[\w@.-]+\.\w{1,8})"/g,
    // Single-quoted paths: 'path/to/file.ts'
    /'((?:[\w@.-]+[/\\]){1,6}[\w@.-]+\.\w{1,8})'/g,
  ];

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    let matchCount = 0;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      if (++matchCount > MAX_MATCHES) break;
      // Last capture group is the path; optional prefix is second-to-last.
      const pathGroup = match[match.length - 1];
      const prefixGroup = match.length >= 3 ? match[match.length - 2] : "";
      if (!pathGroup) continue;
      let raw = (prefixGroup || "") + pathGroup;
      raw = raw.replace(/\\/g, "/");

      // Strip line numbers: src/foo/bar.ts:42 → src/foo/bar.ts
      raw = raw.replace(/:\d+(?::\d+)?$/, "");

      // Strip trailing punctuation
      raw = raw.replace(/[,;.]+$/, "");

      if (!raw) continue;

      const resolved = join(cwd, raw);
      if (!isPathUnderCwd(cwd, resolved)) continue;

      if (!seen.has(resolved)) {
        seen.add(resolved);
        if (existsSync(resolved)) {
          paths.push(relative(cwd, resolved).replace(/\\/g, "/"));
        }
      }
    }
  }

  // Deduplicate by relative path
  return [...new Set(paths)];
}

export function extractTopicFromTask(task: string, filePaths: string[]): string | null {
  // Strategy 1: find dominant directory from file paths (requires ≥3 files, >30% share)
  if (filePaths.length > 0) {
    const dirCounts = new Map<string, number>();
    for (const fp of filePaths) {
      const parts = fp.split("/");
      // Get the first meaningful directory (skip leading ".", "src", "app", "lib", "pkg" unless it's the only dir)
      let topDir = parts[0];
      if (parts.length > 1 && /^(src|app|lib|pkg|internal|cmd|components|pages|utils?)$/.test(topDir)) {
        topDir = parts[1];
      }
      if (topDir && topDir.length > 1 && !/^\./.test(topDir)) {
        dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
      }
    }
    let bestDir = "";
    let bestCount = 0;
    for (const [dir, count] of dirCounts) {
      if (count > bestCount) { bestDir = dir; bestCount = count; }
    }
    // Use directory only if we have ≥3 files and it accounts for >30% of paths
    if (filePaths.length >= 3 && bestDir && bestCount / filePaths.length > 0.3) return bestDir;

    // If 1-2 files, skip Strategy 1 entirely — fall through to Strategy 2
  }

  // Strategy 2: extract from task text — first noun after common verbs
  const taskVerbs = ["explore", "trace", "review", "check", "audit", "scan", "analyze", "investigate", "refactor", "fix", "debug", "test", "document", "migrate", "upgrade"];
  const lower = task.toLowerCase();
  for (const verb of taskVerbs) {
    const idx = lower.indexOf(verb);
    if (idx >= 0) {
      const after = task.slice(idx + verb.length).trim();
      // Try to capture multi-word noun phrase (auth flow, payment gateway, etc.)
      // Skip leading articles (the, a, an)
      const phraseMatch = after.match(/^(?:the |a |an )?([\w-]+(?:\s+[\w-]+)?)/);
      if (phraseMatch && phraseMatch[1].length > 1) {
        return phraseMatch[1].toLowerCase().replace(/\s+/g, "-");
      }
    }
  }

  // Strategy 3: first 2 words of task, skip articles
  const words = task.split(/\s+/);
  const filtered = words.filter(w => !/^(the|a|an|is|are|was|were|that|this|for|with|about|from|into)$/i.test(w));
  const topic = filtered.slice(0, 2).join(" ").toLowerCase();
  return topic.length > 2 ? topic.replace(/\s+/g, "-") : null;
}

// ── Index findings after a fork ──────────────────────────

export interface IndexFindingsInput {
  task: string;
  resultText: string;       // final assistant text from the fork
  stage1Model?: string;     // e.g. "flash"
  stage2Model?: string;     // e.g. "pro"
  stage1bModel?: string;
  stage1cModel?: string;
  stage1BackupModel?: string;
  isReview: boolean;
  quick: boolean;
  cost: number;
  cwd: string;
  promptVersion?: string;   // prompt version used to produce the result
}

export function indexFindings(input: IndexFindingsInput): string | null {
  const topic = buildFindingAndUpdateMemory(input);
  return topic;
}

/** Asynchronous variant: computes the finding in the current tick and writes memory in the background. */
export function indexFindingsAsync(input: IndexFindingsInput): Promise<string | null> {
  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        resolve(buildFindingAndUpdateMemory(input));
      } catch (err) {
        logError(input.cwd, "indexFindingsAsync", err);
        resolve(null);
      }
    });
  });
}

function buildFindingAndUpdateMemory(input: IndexFindingsInput): string | null {
  const { task, resultText, stage1Model, stage2Model, stage1bModel, stage1cModel, isReview, quick, cost, cwd, promptVersion } = input;

  const filePaths = extractFilePaths(resultText, cwd);
  const topic = extractTopicFromTask(task, filePaths);
  if (!topic) return null;

  const memory = loadMemory(cwd);

  // Compute file fingerprints for existing files
  const fingerprints: Record<string, string> = {};
  for (const fp of filePaths.slice(0, 20)) { // cap at 20 files
    const full = join(cwd, fp);
    if (!isPathUnderCwd(cwd, full)) continue;
    const hash = fileFingerprint(full);
    if (hash) fingerprints[fp] = hash;
  }

  // Determine stage for the finding
  let stage: "stage1" | "stage2" | "review";
  let models: string;
  if (isReview) {
    stage = "review";
    models = stage2Model ?? "?";
  } else if (quick) {
    stage = "stage1";
    models = stage1Model ?? "?";
  } else {
    stage = "stage2";
    const scoutParts = [stage1Model, stage1bModel, stage1cModel].filter(Boolean).join("+");
    models = scoutParts && stage2Model ? `${scoutParts}→${stage2Model}` : (stage2Model ?? "?");
  }

  const finding: CdevFindingRecord = {
    text: resultText.slice(0, 2000).replace(/\n/g, " "), // one-line-ish; cap keeps fallback path extraction useful
    timestamp: Date.now(),
    stage,
    models,
    cost,
    promptVersion: promptVersion ?? PROMPT_VERSION,
    fileFingerprints: Object.keys(fingerprints).length > 0 ? fingerprints : undefined,
  };

  let topicEntry = memory.topics[topic];
  if (!topicEntry) {
    topicEntry = {
      name: topic,
      findings: [],
      forkCount: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      files: [],
    };
    memory.topics[topic] = topicEntry;
  }

  topicEntry.findings.unshift(finding);
  topicEntry.forkCount++;
  topicEntry.lastSeen = Date.now();

  // Merge file list
  const existingFiles = new Set(topicEntry.files);
  for (const fp of filePaths) { existingFiles.add(fp); }
  topicEntry.files = Array.from(existingFiles).sort();

  // Cap findings per topic at 20
  if (topicEntry.findings.length > 20) {
    topicEntry.findings = topicEntry.findings.slice(0, 20);
  }

  saveMemory(cwd, memory);
  _topicCountCache = null;
  return topic;
}

// ── Staleness check ──────────────────────────────────────

function checkFreshness(finding: CdevFindingRecord, cwd: string): {
  allFresh: boolean;
  staleFiles: string[];
  checkedFiles: string[];
  hasSnapshot: boolean;
} {
  // If finding has stored fingerprints, use those
  let fingerprints = finding.fileFingerprints;

  // Otherwise, try to extract paths from the finding text as a best-effort fallback
  if (!fingerprints || Object.keys(fingerprints).length === 0) {
    const fallbackPaths = extractFilePaths(finding.text, cwd);
    if (fallbackPaths.length > 0) {
      fingerprints = {};
      for (const fp of fallbackPaths.slice(0, 15)) {
        const hash = fileFingerprint(join(cwd, fp));
        if (hash) fingerprints[fp] = hash;
      }
    }
  }

  if (!fingerprints || Object.keys(fingerprints).length === 0) {
    return { allFresh: false, staleFiles: [], checkedFiles: [], hasSnapshot: false };
  }

  const staleFiles: string[] = [];
  const checkedFiles: string[] = [];

  for (const [filePath, oldHash] of Object.entries(fingerprints)) {
    checkedFiles.push(filePath);
    const currentHash = fileFingerprint(join(cwd, filePath));
    if (!currentHash) {
      staleFiles.push(`${filePath} (deleted)`);
    } else if (currentHash !== oldHash) {
      staleFiles.push(`${filePath} (changed)`);
    }
  }

  return { allFresh: staleFiles.length === 0, staleFiles, checkedFiles, hasSnapshot: true };
}

// ── Formatting for display ───────────────────────────────

export function formatMemoryTopics(memory: CdevMemory): string {
  const topics = Object.values(memory.topics).sort(
    (a, b) => b.lastSeen - a.lastSeen,
  );

  if (topics.length === 0) {
    return "No cdev project memory yet. Run cdev forks to build knowledge.";
  }

  const lines: string[] = [
    "── cdev project memory ─────────────────────────────────────",
    "",
  ];

  for (const topic of topics) {
    const ago = formatTimeAgo(topic.lastSeen);
    const count = topic.forkCount;
    const fileCount = topic.files.length;
    const latestFinding = topic.findings[0]?.text.slice(0, 60) ?? "";
    lines.push(
      `  ${topic.name.padEnd(18)} ${String(count).padStart(2)} fork${count > 1 ? "s" : ""}  ` +
      `${ago.padStart(5)}  ${fileCount}f  ${latestFinding}`,
    );
  }

  lines.push("");
  lines.push(`  /cdev recall <topic> to view findings`);
  lines.push(`  /cdev clear to wipe all memory`);
  lines.push("──────────────────────────────────────────────────────────");
  return lines.join("\n");
}

export function formatTopicDetail(topic: CdevTopic, cwd: string): string {
  // Pre-compute freshness for all findings
  const enriched = topic.findings.map((f) => ({
    finding: f,
    freshness: checkFreshness(f, cwd),
  }));

  const totalFresh = enriched.filter((e) => e.freshness.hasSnapshot && e.freshness.allFresh).length;
  const totalStale = enriched.filter((e) => e.freshness.hasSnapshot && !e.freshness.allFresh).length;
  const totalUnverified = enriched.filter((e) => !e.freshness.hasSnapshot).length;

  // ── Trust warning header ──
  let trustHeader: string;
  if (totalStale === 0 && totalUnverified === 0) {
    trustHeader = "✅ All findings verified fresh — code unchanged since stored. Trust freely.";
  } else if (totalStale > 0 && totalFresh === 0 && totalUnverified === 0) {
    trustHeader = "⚠️ ALL FINDINGS STALE — code has changed. VERIFY EVERYTHING before acting. Do not trust any finding below without re-checking the actual code.";
  } else {
    const parts: string[] = [];
    if (totalStale > 0) parts.push(`${totalStale} stale — VERIFY before using`);
    if (totalUnverified > 0) parts.push(`${totalUnverified} unverified — treat as suggestions, not facts`);
    if (totalFresh > 0) parts.push(`${totalFresh} fresh — trustworthy`);
    trustHeader = `🚦 MIXED: ${parts.join(" | ")}`;
  }

  const lines: string[] = [
    `── cdev memory: ${topic.name} ──────────────────────────────────`,
    "",
    `    ${topic.forkCount} fork${topic.forkCount > 1 ? "s" : ""}  •  ` +
    `${topic.files.length} file${topic.files.length > 1 ? "s" : ""}  •  ` +
    `first seen ${new Date(topic.firstSeen).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    "",
    `    ${trustHeader}`,
    "",
  ];

  for (let i = 0; i < enriched.length; i++) {
    const { finding: f, freshness } = enriched[i];
    const date = new Date(f.timestamp).toLocaleDateString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

    let icon: string;
    if (!freshness.hasSnapshot) {
      icon = "❓";
    } else if (freshness.allFresh) {
      icon = "✅";
    } else {
      icon = "⚠️";
    }

    const costStr = f.cost > 0 ? formatCost(f.cost) : "";
    const text = f.text.slice(0, 100);

    lines.push(`  ${icon} ${date}  ${f.stage}  ${f.models.padEnd(15)} ${costStr}`);
    lines.push(`     ${text}`);
    if (freshness.staleFiles.length > 0) {
      for (const sf of freshness.staleFiles.slice(0, 3)) {
        lines.push(`     ↳ stale: ${sf}`);
      }
      if (freshness.staleFiles.length > 3) {
        lines.push(`     ↳ ...and ${freshness.staleFiles.length - 3} more changed`);
      }
    }
    if (i < topic.findings.length - 1) lines.push("");
  }

  lines.push("");
  if (totalStale > 0) {
    lines.push(`    ⚠ ${totalStale} finding${totalStale > 1 ? "s" : ""} stale — /cdev memory refresh ${topic.name} to re-explore`);
  }
  if (totalUnverified > 0) {
    lines.push(`    ❓ ${totalUnverified} unverified — no file snapshot to check against`);
  }
  lines.push("──────────────────────────────────────────────────────────");
  return lines.join("\n");
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// ── Memory operations ────────────────────────────────────

export function memoryClear(cwd: string): void {
  saveMemory(cwd, { version: 1, topics: {} });
  _topicCountCache = null;
}

export function memoryForget(cwd: string, topic: string): boolean {
  const memory = loadMemory(cwd);
  if (!memory.topics[topic]) return false;
  delete memory.topics[topic];
  saveMemory(cwd, memory);
  _topicCountCache = null;
  return true;
}

// ── Topic auto-merge ───────────────────────────────────────

function topicSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const nb = b.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (na === nb) return 1;
  const tokensA = new Set(na.split(/\s+/).filter(Boolean));
  const tokensB = new Set(nb.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  return intersection.size / Math.max(tokensA.size, tokensB.size);
}

export function mergeSimilarTopics(cwd: string, threshold = 0.6): string[] {
  const memory = loadMemory(cwd);
  const topics = Object.keys(memory.topics);
  if (topics.length < 2) return [];

  const merged: string[] = [];
  const visited = new Set<string>();

  for (let i = 0; i < topics.length; i++) {
    const a = topics[i];
    if (visited.has(a)) continue;
    visited.add(a);

    for (let j = i + 1; j < topics.length; j++) {
      const b = topics[j];
      if (visited.has(b)) continue;
      if (topicSimilarity(a, b) >= threshold) {
        const target = memory.topics[a];
        const source = memory.topics[b];
        if (!target || !source) continue;

        // Merge findings (newest first), keeping up to 20 total
        const combinedFindings = [...source.findings, ...target.findings].sort((x, y) => y.timestamp - x.timestamp).slice(0, 20);
        target.findings = combinedFindings;
        target.forkCount += source.forkCount;
        target.lastSeen = Math.max(target.lastSeen, source.lastSeen);

        // Merge file list
        const fileSet = new Set([...target.files, ...source.files]);
        target.files = Array.from(fileSet).sort();

        delete memory.topics[b];
        visited.add(b);
        merged.push(`${b} → ${a}`);
      }
    }
  }

  if (merged.length > 0) {
    saveMemory(cwd, memory);
    _topicCountCache = null;
  }
  return merged;
}

export function memoryGetTopic(cwd: string, topic: string): CdevTopic | null {
  const memory = loadMemory(cwd);
  return memory.topics[topic] ?? null;
}

export function memoryGetTopics(cwd: string): CdevTopic[] {
  const memory = loadMemory(cwd);
  return Object.values(memory.topics).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function topicHasStaleFindings(topic: CdevTopic, cwd: string): boolean {
  return topic.findings.some((f) => {
    const freshness = checkFreshness(f, cwd);
    return freshness.hasSnapshot && !freshness.allFresh;
  });
}

/** In-memory cache for topic count (invalidated on write). */
let _topicCountCache: { cwd: string; count: number; mtime: number } | null = null;

export function memoryTopicCount(cwd: string): number {
  const memoryPath = getMemoryPath(cwd);
  // Use file mtime to detect changes; skip re-parse if unchanged
  if (_topicCountCache && _topicCountCache.cwd === cwd) {
    try {
      if (existsSync(memoryPath)) {
        const mtime = statSync(memoryPath).mtimeMs;
        if (Math.floor(mtime) === Math.floor(_topicCountCache.mtime)) return _topicCountCache.count;
      } else if (_topicCountCache.count === 0) {
        return 0;
      }
    } catch (err) {
      logWarn(cwd, "memoryTopicCount", "failed to read memory mtime", { error: String(err) });
    }
  }
  const memory = loadMemory(cwd);
  const count = Object.keys(memory.topics).length;
  try {
    const mtime = existsSync(memoryPath) ? Math.floor(statSync(memoryPath).mtimeMs) : 0;
    _topicCountCache = { cwd, count, mtime };
  } catch (err) {
    logWarn(cwd, "memoryTopicCount", "failed to update topic count cache", { error: String(err) });
  }
  return count;
}
