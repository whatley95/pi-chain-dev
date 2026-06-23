import type { Stage1Findings, Stage2Report } from "./types.js";
import { isStage1Findings, isStage2Report } from "./types.js";

export { isStage1Findings, isStage2Report };

export function extractJsonFromText(text: string): string | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonObject<T>(text: string, guard: (value: unknown) => value is T): T | null {
  const jsonText = extractJsonFromText(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (!guard(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseStage1Findings(text: string): Stage1Findings | null {
  return parseJsonObject(text, isStage1Findings);
}

export function parseStage2Report(text: string): Stage2Report | null {
  return parseJsonObject(text, isStage2Report);
}

export function formatStage2Report(report: Stage2Report): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status}`);
  lines.push("");
  lines.push(report.summary);
  lines.push("");
  lines.push(`## Output`);
  lines.push(report.output);
  lines.push("");
  lines.push(`## Evidence`);
  lines.push(report.evidence);
  lines.push("");
  if (report.groundingScore !== undefined) {
    const pct = Math.round(report.groundingScore * 100);
    const icon = pct >= 80 ? "✅" : pct >= 50 ? "⚠️" : "❌";
    lines.push(`## Grounding ${icon} ${pct}%`);
    if (report.ungroundedClaims && report.ungroundedClaims.length > 0) {
      for (const claim of report.ungroundedClaims.slice(0, 10)) {
        lines.push(`- ${claim}`);
      }
    } else {
      lines.push("All claims are grounded in the exploration evidence.");
    }
    lines.push("");
  }
  lines.push(`## Learnings`);
  lines.push(report.learnings);
  if (report.actionItems.length > 0) {
    lines.push("");
    lines.push(`## Action Items`);
    for (const item of report.actionItems) {
      const clean = item.replace(/^\s*[-*]\s*/, "").trim();
      lines.push(`- [ ] ${clean}`);
    }
  }
  return lines.join("\n");
}

export function computeReportDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const normalize = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("- [ ]") && !line.startsWith("- [x]"));

  const oldLines = new Set(normalize(oldText));
  const newLines = new Set(normalize(newText));

  const added = [...newLines].filter((line) => !oldLines.has(line));
  const removed = [...oldLines].filter((line) => !newLines.has(line));
  return { added, removed };
}

export function formatReportDiff(diff: { added: string[]; removed: string[] }): string {
  const lines: string[] = [];
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return "No significant changes detected vs previous report.";
  }
  if (diff.added.length > 0) {
    lines.push("### New");
    for (const line of diff.added.slice(0, 30)) lines.push(`+ ${line}`);
    if (diff.added.length > 30) lines.push(`+ ... and ${diff.added.length - 30} more`);
  }
  if (diff.removed.length > 0) {
    lines.push("");
    lines.push("### Removed / Changed");
    for (const line of diff.removed.slice(0, 30)) lines.push(`- ${line}`);
    if (diff.removed.length > 30) lines.push(`- ... and ${diff.removed.length - 30} more`);
  }
  return lines.join("\n");
}
