import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";

export function sanitizeReportFileName(fileName: string): string {
  // Strip any path separators and parent-directory attempts, keep only a safe basename.
  const base = basename(fileName.replace(/\\/g, "/"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "report";
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
      try { appendFileSync(appendTo, appendBody, "utf-8"); } catch { /* ignore */ }
    }
    written = true;
    return { reportRelPath, written };
  } catch {
    return { reportRelPath: "", written };
  }
}
