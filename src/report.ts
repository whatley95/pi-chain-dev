import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { logError } from "./logger.js";
import { PROMPT_VERSION } from "./prompt-version.js";

export function sanitizeReportFileName(fileName: string): string {
  // Strip any path separators and parent-directory attempts, keep only a safe basename.
  const base = basename(fileName.replace(/\\/g, "/"));
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "report";
  // Avoid hidden files (leading dot).
  return safe.replace(/^\.+/, "-");
}

export function sanitizeReportBody(body: string): string {
  // Strip common reasoning/thinking markers that some models emit as regular text.
  // This prevents internal chain-of-thought from corrupting saved reports.
  const patterns = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<analysis>[\s\S]*?<\/analysis>/gi,
    /--- BEGIN REASONING ---[\s\S]*?--- END REASONING ---/gi,
    /--- BEGIN THINKING ---[\s\S]*?--- END THINKING ---/gi,
    /\[thinking\][\s\S]*?\[\/thinking\]/gi,
    /\[reasoning\][\s\S]*?\[\/reasoning\]/gi,
  ];
  let cleaned = body;
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

export function writeReportFile(opts: {
  cwd: string;
  fileName: string;
  title: string;
  reviewer?: string;
  body: string;
}): { reportRelPath: string; written: boolean; error?: string } {
  const { cwd, fileName, title, reviewer, body } = opts;
  const reportsDir = join(cwd, ".pi", "cdev", "reports");
  const safeName = sanitizeReportFileName(fileName);
  const reportRelPath = `.pi/cdev/reports/${safeName}`;
  try {
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, safeName);
    const date = new Date().toISOString().split("T")[0];
    const header = reviewer
      ? `# ${title}\n\n**Date:** ${date}\n**Reviewer:** ${reviewer}\n**Prompt version:** ${PROMPT_VERSION}\n\n`
      : `# ${title}\n\n**Date:** ${date}\n**Prompt version:** ${PROMPT_VERSION}\n\n`;
    const cleanBody = sanitizeReportBody(body);
    writeFileSync(reportPath, `${header}${cleanBody}\n`, "utf-8");
    return { reportRelPath, written: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError(cwd, "writeReportFile", err, { fileName: safeName });
    return { reportRelPath: "", written: false, error };
  }
}
