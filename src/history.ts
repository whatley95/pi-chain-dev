/**
 * cdev session history — local telemetry, auto-purged after 7 days.
 *
 * Records stored in .pi/cdev/sessions/ as individual JSON files.
 * Not committed to git (pi dirs are gitignored).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AutoForkDetails, ForkResult } from "./types.js";
import { getFinalAssistantText } from "./runner-events.js";
import { logError, formatCost } from "./extension-context.js";
import { logWarn } from "./logger.js";

// ── Types ──────────────────────────────────────────────

export interface SessionRecord {
  /** Unique ID for this session (ISO timestamp + random hex suffix). */
  id: string;
  /** What the user asked / the task string. */
  task: string;
  /** Whether this was review-only mode. */
  isReview: boolean;
  /** ISO timestamp when it started. */
  startedAt: string;
  /** ISO timestamp when it finished. */
  finishedAt: string;
  /** Duration in ms. */
  durationMs: number;
  /** Stage 1 details (null for review mode). */
  stage1: {
    model: string;
    exitCode: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    errorDetails: string;
  } | null;
  /** Stage 1B details (only in verify mode). */
  stage1b?: {
    model: string;
    exitCode: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    errorDetails: string;
  } | null;
  /** Stage 1C details (parallel mode). */
  stage1c?: {
    model: string;
    exitCode: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    errorDetails: string;
  } | null;
  /** Backup scout details (parallel mode). */
  stage1Backup?: {
    model: string;
    exitCode: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    errorDetails: string;
  } | null;
  /** Stage 2 details (null for quick mode). */
  stage2: {
    model: string;
    exitCode: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    errorDetails: string;
  } | null;
  /** Overall status. */
  status: "success" | "failed";
  /** First 200 chars of final output. */
  resultPreview: string;
  /** Stored full final output for diffing. */
  resultText?: string;
}

// ── Storage ────────────────────────────────────────────

function getSessionsDir(cwd: string): string {
  return join(cwd, ".pi", "cdev", "sessions");
}

export function saveSession(
  cwd: string,
  task: string,
  isReview: boolean,
  startedAt: number,
  details: AutoForkDetails,
  result: ForkResult,
): SessionRecord {
  const dir = getSessionsDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const id = new Date(startedAt).toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(8).toString("hex");
  const resultText = getFinalAssistantText(result.messages) || "";
  
  const record: SessionRecord = {
    id,
    task: task.slice(0, 500),
    isReview,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now).toISOString(),
    durationMs: now - startedAt,
    stage1: details.stage1
      ? {
          model: (details.stage1.provider && details.stage1.model)
            ? `${details.stage1.provider}:${details.stage1.model}`
            : details.stage1.model ?? "unknown",
          exitCode: details.stage1.exitCode ?? -1,
          inputTokens: details.stage1.usage?.input ?? 0,
          outputTokens: details.stage1.usage?.output ?? 0,
          cost: details.stage1.usage?.cost ?? 0,
          errorDetails: (details.stage1.errorMessage || details.stage1.stderr || "").slice(0, 200),
        }
      : null,
    stage1b: details.stage1b
      ? {
          model: (details.stage1b.provider && details.stage1b.model)
            ? `${details.stage1b.provider}:${details.stage1b.model}`
            : details.stage1b.model ?? "unknown",
          exitCode: details.stage1b.exitCode ?? -1,
          inputTokens: details.stage1b.usage?.input ?? 0,
          outputTokens: details.stage1b.usage?.output ?? 0,
          cost: details.stage1b.usage?.cost ?? 0,
          errorDetails: (details.stage1b.errorMessage || details.stage1b.stderr || "").slice(0, 200),
        }
      : null,
    stage1c: details.stage1c
      ? {
          model: (details.stage1c.provider && details.stage1c.model)
            ? `${details.stage1c.provider}:${details.stage1c.model}`
            : details.stage1c.model ?? "unknown",
          exitCode: details.stage1c.exitCode ?? -1,
          inputTokens: details.stage1c.usage?.input ?? 0,
          outputTokens: details.stage1c.usage?.output ?? 0,
          cost: details.stage1c.usage?.cost ?? 0,
          errorDetails: (details.stage1c.errorMessage || details.stage1c.stderr || "").slice(0, 200),
        }
      : null,
    stage1Backup: details.stage1Backup
      ? {
          model: (details.stage1Backup.provider && details.stage1Backup.model)
            ? `${details.stage1Backup.provider}:${details.stage1Backup.model}`
            : details.stage1Backup.model ?? "unknown",
          exitCode: details.stage1Backup.exitCode ?? -1,
          inputTokens: details.stage1Backup.usage?.input ?? 0,
          outputTokens: details.stage1Backup.usage?.output ?? 0,
          cost: details.stage1Backup.usage?.cost ?? 0,
          errorDetails: (details.stage1Backup.errorMessage || details.stage1Backup.stderr || "").slice(0, 200),
        }
      : null,
    stage2: details.stage2
      ? {
          model: (details.stage2.provider && details.stage2.model)
            ? `${details.stage2.provider}:${details.stage2.model}`
            : details.stage2.model ?? "unknown",
          exitCode: details.stage2.exitCode ?? -1,
          inputTokens: details.stage2.usage?.input ?? 0,
          outputTokens: details.stage2.usage?.output ?? 0,
          cost: details.stage2.usage?.cost ?? 0,
          errorDetails: (details.stage2.errorMessage || details.stage2.stderr || "").slice(0, 200),
        }
      : null,
    status: result.exitCode === 0 ? "success" : "failed",
    resultPreview: resultText.slice(0, 200),
    resultText,
  };

  const filePath = join(dir, `${id}.json`);
  try {
    writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Don't let disk error nuke fork output, but log to error trail
    logError(cwd, "saveSession", err);
  }
  return record;
}

// ── Load & List ────────────────────────────────────────

export function listSessions(cwd: string): SessionRecord[] {
  const dir = getSessionsDir(cwd);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse(); // newest first

  const records: SessionRecord[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      records.push(raw as SessionRecord);
    } catch (err) {
      logWarn(cwd, "listSessions", `skipping corrupted session file ${file}`, { error: String(err) });
    }
  }
  return records;
}

export function getSession(cwd: string, index: number): SessionRecord | null {
  const sessions = listSessions(cwd);
  if (index < 1 || index > sessions.length) return null;
  return sessions[index - 1]; // 1-indexed for user display
}

/** Find the most recent previous session matching a task (case-insensitive substring). */
export function findPreviousSession(cwd: string, task: string): SessionRecord | null {
  const sessions = listSessions(cwd);
  const lower = task.toLowerCase();
  for (const s of sessions) {
    if (s.task.toLowerCase().includes(lower)) return s;
  }
  return null;
}

// ── Purge old sessions ─────────────────────────────────

export function purgeOldSessions(cwd: string, maxAgeDays = 7): number {
  const dir = getSessionsDir(cwd);
  if (!existsSync(dir)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let purged = 0;

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < cutoff) {
          unlinkSync(filePath);
          purged++;
        }
      } catch (err) {
        logWarn(cwd, "purgeOldSessions", `failed to purge ${file}`, { error: String(err) });
      }
    }
  } catch (err) {
    logWarn(cwd, "purgeOldSessions", "failed to list sessions dir", { error: String(err) });
  }

  return purged;
}

// ── Formatting ─────────────────────────────────────────

export function formatHistory(sessions: SessionRecord[]): string {
  if (sessions.length === 0) return "No cdev sessions recorded yet.";

  const lines: string[] = ["── cdev sessions ───────────────────────────────────────────"];
  
  let totalCost = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const date = new Date(s.startedAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const duration = (s.durationMs / 1000).toFixed(1) + "s";
    const mode = s.isReview ? "review" : "full  ";
    const status = s.status === "success" ? "✓" : "✗";
    const combinedCost = (s.stage1?.cost ?? 0) + (s.stage1b?.cost ?? 0) + (s.stage1c?.cost ?? 0) + (s.stage1Backup?.cost ?? 0) + (s.stage2?.cost ?? 0);
    totalCost += combinedCost;
    const costStr = combinedCost > 0 ? ` ${formatCost(combinedCost)}`.padStart(9) : "";
    const s1Model = s.stage1 ? s.stage1.model.split(":").pop()?.slice(0, 12) ?? "?" : "—";
    const s1bModel = s.stage1b ? s.stage1b.model.split(":").pop()?.slice(0, 12) ?? "" : "";
    const s1cModel = s.stage1c ? s.stage1c.model.split(":").pop()?.slice(0, 12) ?? "" : "";
    const s2Model = s.stage2 ? s.stage2.model.split(":").pop()?.slice(0, 12) ?? "?" : "—";
    const scoutParts = [s1Model, s1bModel, s1cModel].filter(Boolean);
    const scoutPart = scoutParts.length > 1 ? scoutParts.join("+") : s1Model;
    const models = s.stage1 && s.stage2 ? `${scoutPart}→${s2Model}` : (s.stage1 || s.stage2 ? scoutPart !== "—" ? scoutPart : s2Model : "?");
    const task = s.task.length > 40 ? s.task.slice(0, 40) + "…" : s.task;

    lines.push(
      `  ${String(i + 1).padStart(2, " ")}. ${status} ${mode} ${date} ${duration.padStart(6)}${costStr} ${models.padEnd(22)} ${task}`,
    );
  }

  lines.push("─────────────────────────────────────────────────────");
  if (totalCost > 0) {
    lines.push(`  Total cost: ${formatCost(totalCost)} across ${sessions.length} session${sessions.length > 1 ? "s" : ""}`);
  }
  lines.push(`  /cdev history <n> to see full report`);
  lines.push(`  Sessions auto-purged after 7 days`);

  return lines.join("\n");
}

export function formatSessionRecord(s: SessionRecord): string {
  const lines: string[] = [
    "── cdev session detail ──────────────────────────────",
    "",
    `  Task:       ${s.task}`,
    `  Started:    ${new Date(s.startedAt).toLocaleString()}`,
    `  Duration:   ${(s.durationMs / 1000).toFixed(1)}s`,
    `  Mode:       ${s.isReview ? "review only" : "full (stage 1 → stage 2)"}`,
    `  Status:     ${s.status === "success" ? "✅ success" : "❌ failed"}`,
    "",
  ];

  if (s.stage1) {
    lines.push(`  Stage 1 (explore):`, ``);
    lines.push(`    Model:      ${s.stage1.model}`);
    lines.push(`    Exit code:  ${s.stage1.exitCode}`);
    if (s.stage1.inputTokens || s.stage1.outputTokens) {
      lines.push(`    Tokens:     ${s.stage1.inputTokens} in / ${s.stage1.outputTokens} out`);
    }
    if (s.stage1.cost > 0) {
      lines.push(`    Cost:       ${formatCost(s.stage1.cost)}`);
    }
    if (s.stage1.errorDetails) lines.push(`    Error:      ${s.stage1.errorDetails}`);
    lines.push("");
  }

  if (s.stage1b) {
    lines.push(`  Stage 1B (verify scout):`, ``);
    lines.push(`    Model:      ${s.stage1b.model}`);
    lines.push(`    Exit code:  ${s.stage1b.exitCode}`);
    if (s.stage1b.inputTokens || s.stage1b.outputTokens) {
      lines.push(`    Tokens:     ${s.stage1b.inputTokens} in / ${s.stage1b.outputTokens} out`);
    }
    if (s.stage1b.cost > 0) {
      lines.push(`    Cost:       ${formatCost(s.stage1b.cost)}`);
    }
    if (s.stage1b.errorDetails) lines.push(`    Error:      ${s.stage1b.errorDetails}`);
    lines.push("");
  }

  if (s.stage1c) {
    lines.push(`  Stage 1C (parallel scout):`, ``);
    lines.push(`    Model:      ${s.stage1c.model}`);
    lines.push(`    Exit code:  ${s.stage1c.exitCode}`);
    if (s.stage1c.inputTokens || s.stage1c.outputTokens) {
      lines.push(`    Tokens:     ${s.stage1c.inputTokens} in / ${s.stage1c.outputTokens} out`);
    }
    if (s.stage1c.cost > 0) {
      lines.push(`    Cost:       ${formatCost(s.stage1c.cost)}`);
    }
    if (s.stage1c.errorDetails) lines.push(`    Error:      ${s.stage1c.errorDetails}`);
    lines.push("");
  }

  if (s.stage1Backup) {
    lines.push(`  Backup scout (parallel):`, ``);
    lines.push(`    Model:      ${s.stage1Backup.model}`);
    lines.push(`    Exit code:  ${s.stage1Backup.exitCode}`);
    if (s.stage1Backup.inputTokens || s.stage1Backup.outputTokens) {
      lines.push(`    Tokens:     ${s.stage1Backup.inputTokens} in / ${s.stage1Backup.outputTokens} out`);
    }
    if (s.stage1Backup.cost > 0) {
      lines.push(`    Cost:       ${formatCost(s.stage1Backup.cost)}`);
    }
    if (s.stage1Backup.errorDetails) lines.push(`    Error:      ${s.stage1Backup.errorDetails}`);
    lines.push("");
  }

  if (s.stage2) {
    lines.push(`  Stage 2 (synthesize):`, ``);
    lines.push(`    Model:      ${s.stage2.model}`);
    lines.push(`    Exit code:  ${s.stage2.exitCode}`);
    if (s.stage2.inputTokens || s.stage2.outputTokens) {
      lines.push(`    Tokens:     ${s.stage2.inputTokens} in / ${s.stage2.outputTokens} out`);
    }
    if (s.stage2.cost > 0) {
      lines.push(`    Cost:       ${formatCost(s.stage2.cost)}`);
    }
    if (s.stage2.errorDetails && s.stage2.errorDetails !== s.resultPreview) {
      lines.push(`    Error:      ${s.stage2.errorDetails}`);
    }
  }

  const totalCost = (s.stage1?.cost ?? 0) + (s.stage1b?.cost ?? 0) + (s.stage1c?.cost ?? 0) + (s.stage1Backup?.cost ?? 0) + (s.stage2?.cost ?? 0);
  if (totalCost > 0) {
    lines.push("");
    lines.push(`  Total cost:  ${formatCost(totalCost)}`);
  }
  lines.push("");

  if (s.resultPreview) {
    lines.push(`  Result preview:`, ``);
    lines.push(`    ${s.resultPreview.slice(0, 300)}`);
    lines.push("");
  }

  lines.push("──────────────────────────────────────────────────────");
  return lines.join("\n");
}
