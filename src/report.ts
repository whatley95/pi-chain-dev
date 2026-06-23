import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { logError, logWarn } from "./logger.js";
import { isPathUnderCwd } from "./path-guards.js";
import { PROMPT_VERSION } from "./prompt-version.js";

export function sanitizeReportFileName(fileName: string): string {
  // Strip any path separators and parent-directory attempts, keep only a safe basename.
  const base = basename(fileName.replace(/\\/g, "/"));
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "report";
  // Avoid hidden files (leading dot).
  return safe.replace(/^\.+/, "-");
}

export function writeReportFile(opts: {
  cwd: string;
  fileName: string;
  title: string;
  reviewer?: string;
  body: string;
  appendTo?: string;
  appendBody?: string;
}): { reportRelPath: string; written: boolean; error?: string } {
  const { cwd, fileName, title, reviewer, body, appendTo, appendBody } = opts;
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
    writeFileSync(reportPath, `${header}${body}\n`, "utf-8");
    if (appendTo && appendBody) {
      const appendTarget = resolve(cwd, appendTo);
      if (existsSync(appendTarget) && isPathUnderCwd(cwd, appendTarget)) {
        try {
          appendFileSync(appendTarget, appendBody, "utf-8");
        } catch (err) {
          logWarn(cwd, "writeReportFile", "failed to append to target file", { appendTo, error: String(err) });
        }
      } else {
        logWarn(cwd, "writeReportFile", "append target rejected", { appendTo });
      }
    }
    return { reportRelPath, written: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError(cwd, "writeReportFile", err, { fileName: safeName });
    return { reportRelPath: "", written: false, error };
  }
}
