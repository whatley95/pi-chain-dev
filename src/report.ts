import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, basename, resolve, relative } from "node:path";

export function sanitizeReportFileName(fileName: string): string {
  // Strip any path separators and parent-directory attempts, keep only a safe basename.
  const base = basename(fileName.replace(/\\/g, "/"));
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "report";
  // Avoid hidden files (leading dot).
  return safe.replace(/^\.+/, "-");
}

function isPathUnderCwd(cwd: string, target: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedCwd, resolvedTarget);
  return !rel.startsWith("..") && rel !== "";
}

export function writeReportFile(opts: {
  cwd: string;
  fileName: string;
  title: string;
  reviewer?: string;
  body: string;
  appendTo?: string;
  appendBody?: string;
}): { reportRelPath: string; written: boolean } {
  const { cwd, fileName, title, reviewer, body, appendTo, appendBody } = opts;
  const reportsDir = join(cwd, ".pi", "cdev", "reports");
  const safeName = sanitizeReportFileName(fileName);
  let written = false;
  try {
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, safeName);
    const reportRelPath = `.pi/cdev/reports/${safeName}`;
    const date = new Date().toISOString().split("T")[0];
    const header = reviewer ? `# ${title}\n\n**Date:** ${date}\n**Reviewer:** ${reviewer}\n\n` : `# ${title}\n\n**Date:** ${date}\n\n`;
    writeFileSync(reportPath, `${header}${body}\n`, "utf-8");
    if (appendTo && appendBody) {
      const appendTarget = resolve(cwd, appendTo);
      if (existsSync(appendTarget) && isPathUnderCwd(cwd, appendTarget)) {
        try { appendFileSync(appendTarget, appendBody, "utf-8"); } catch { /* ignore */ }
      }
    }
    written = true;
    return { reportRelPath, written };
  } catch {
    return { reportRelPath: "", written };
  }
}
