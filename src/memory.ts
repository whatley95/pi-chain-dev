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
 *   /cdev clear            — alias for memory clear
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { CdevMemory, CdevTopic, CdevFindingRecord } from "./types.js";

// ── Storage ──────────────────────────────────────────────

function getMemoryPath(cwd: string): string {
  return join(cwd, ".pi", "cdev", "memory.json");
}

function ensureDir(cwd: string): void {
  const dir = join(cwd, ".pi", "cdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadMemory(cwd: string): CdevMemory {
  const path = getMemoryPath(cwd);
  if (!existsSync(path)) return { version: 1, topics: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && raw.version === 1 && raw.topics) {
      return raw as CdevMemory;
    }
    return { version: 1, topics: {} };
  } catch {
    return { version: 1, topics: {} };
  }
}

function saveMemory(cwd: string, memory: CdevMemory): void {
  ensureDir(cwd);
  const path = getMemoryPath(cwd);
  const tmpPath = path + ".tmp";
  try {
    // Atomic write: write to temp file, then rename to avoid concurrent-write corruption
    writeFileSync(tmpPath, JSON.stringify(memory, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, path);
  } catch {
    // fail silently — don't let disk error nuke fork output
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
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

function extractFilePaths(text: string, cwd: string): string[] {
  // Multiple patterns to catch different path representations
  const patterns = [
    // Explicit paths: src/foo/bar.ts, app/models/user.rb
    /(?:^|\s|[`'"([{<])(\.{0,2}[/\\])?([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))(?:[:"',)}\]>\s]|$)/gm,
    // Paths after common markers: "in file X", "at path X", "the file X"
    /(?:file|path|module|package|class)\s+[`'"]?(\.{0,2}[/\\])?([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))[`'"]?/gi,
    // Backtick-enclosed paths (common in markdown): `src/foo/bar.ts`
    /`(\.{0,2}[/\\])?([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))`/g,
    // JSON-like paths: "path/to/file.ts"
    /"([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))"/g,
  ];

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      // Extract the full path from capture groups
      let raw: string;
      if (match.length === 4) {
        // Pattern with prefix + path
        raw = (match[2] || "") + match[3];
      } else if (match.length === 3) {
        // Pattern with optional prefix + path
        raw = (match[1] || "") + match[2];
      } else {
        raw = match[1];
      }

      if (!raw) continue;
      raw = raw.replace(/\\/g, "/");

      // Strip line numbers: src/foo/bar.ts:42 → src/foo/bar.ts
      raw = raw.replace(/:\d+(?::\d+)?$/, "");

      // Strip trailing punctuation
      raw = raw.replace(/[,;.]+$/, "");

      // Normalize leading ./ or ../
      const resolved = join(cwd, raw);

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

function extractTopicFromTask(task: string, filePaths: string[]): string | null {
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
      const phraseMatch = after.match(/^([\w-]+(?:\s+[\w-]+)?)/);
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
  isReview: boolean;
  quick: boolean;
  cost: number;
  cwd: string;
}

export function indexFindings(input: IndexFindingsInput): string | null {
  const { task, resultText, stage1Model, stage2Model, isReview, quick, cost, cwd } = input;

  const filePaths = extractFilePaths(resultText, cwd);
  const topic = extractTopicFromTask(task, filePaths);
  if (!topic) return null;

  const memory = loadMemory(cwd);

  // Compute file fingerprints for existing files
  const fingerprints: Record<string, string> = {};
  for (const fp of filePaths.slice(0, 20)) { // cap at 20 files
    const hash = fileFingerprint(join(cwd, fp));
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
    models = stage1Model && stage2Model ? `${stage1Model}→${stage2Model}` : (stage2Model ?? "?");
  }

  const finding: CdevFindingRecord = {
    text: resultText.slice(0, 500).replace(/\n/g, " "), // one-line-ish
    timestamp: Date.now(),
    stage,
    models,
    cost,
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

    const costStr = f.cost > 0 ? `$${f.cost.toFixed(4)}` : "";
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
  const seconds = Math.floor((Date.now() - ts) / 1000);
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
}

export function memoryForget(cwd: string, topic: string): boolean {
  const memory = loadMemory(cwd);
  if (!memory.topics[topic]) return false;
  delete memory.topics[topic];
  saveMemory(cwd, memory);
  return true;
}

export function memoryGetTopic(cwd: string, topic: string): CdevTopic | null {
  const memory = loadMemory(cwd);
  return memory.topics[topic] ?? null;
}

export function memoryGetTopics(cwd: string): CdevTopic[] {
  const memory = loadMemory(cwd);
  return Object.values(memory.topics).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function memoryTopicCount(cwd: string): number {
  const memory = loadMemory(cwd);
  return Object.keys(memory.topics).length;
}

// ── Error log helpers ─────────────────────────────────────

export function getErrorCount(cwd: string): number {
  try {
    const path = join(cwd, ".pi", "cdev", "errors.jsonl");
    if (!existsSync(path)) return 0;
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return 0;
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

export function clearErrorLog(cwd: string): void {
  try {
    const path = join(cwd, ".pi", "cdev", "errors.jsonl");
    if (existsSync(path)) writeFileSync(path, "", "utf-8");
  } catch {
    // ignore
  }
}
