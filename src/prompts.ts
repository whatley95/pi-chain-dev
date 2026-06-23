import { appendTaskToSessionJsonl } from "./fork-stage.js";

export const STAGE_AUDIT_GUARD = "\n\n⚠️ AUDIT ONLY — DO NOT implement, modify, or write any code. Only report findings and suggestions.";

export function buildStage1Prompt(task: string, customPrompt?: string, editMode?: boolean): string {
  const guard = editMode ? "" : STAGE_AUDIT_GUARD;
  const jsonSchema = `{
  "summary": "one-sentence summary of what was explored",
  "findings": [
    {
      "file": "optional relative file path",
      "observation": "concrete observation",
      "evidence": "supporting snippet, command output, or value",
      "confidence": "high|medium|low"
    }
  ],
  "deadEnds": ["optional paths that did not pan out"],
  "assumptions": ["optional assumptions made"],
  "openQuestions": ["optional questions for the main agent"]
}`;
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

Return your findings as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Efficiency rules:
- Batch reads: use \`bash\`, \`cat\`, \`grep\`, \`find\`, \`ls\`, or globs instead of many individual \`read\` calls.
- Example: \`bash: cat src/**/*.ts | grep -n "pattern"\` reads many files in one tool call.
- Read a file individually only when you need the full content of a specific, named file.${guard}`;
  }
  return `${task}

You are in EXPLORATION MODE. Your job is to gather information, not to write a final report.

Instructions:
- Explore thoroughly using available tools (read, bash, ls, grep, find, etc.)
- Gather concrete evidence: file contents, command outputs, config values
- Return your findings as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Efficiency rules:
- Batch reads: use \`bash\`, \`cat\`, \`grep\`, \`find\`, \`ls\`, or globs instead of many individual \`read\` calls.
- Example: \`bash: cat src/**/*.ts | grep -n "pattern"\` reads many files in one tool call.
- Read a file individually only when you need the full content of a specific, named file.
- Stop exploring once you have enough evidence to answer the task.

Rules:
- "summary" is required and must be one sentence.
- "findings" is required. Each finding must have "observation" and "confidence".
- "file" and "evidence" are optional but strongly preferred when applicable.
- "deadEnds", "assumptions", "openQuestions" are optional.
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings" outside the JSON.
- Do NOT write a decision-useful report. Only return the JSON object.${guard}`;
}

export function buildStage2Prompt(task: string, stage1Output: string, customPrompt?: string, editMode?: boolean): string {
  const guard = editMode ? "" : STAGE_AUDIT_GUARD;
  const jsonSchema = `{
  "status": "ok|needs-work|blocked|exploratory",
  "summary": "one-paragraph summary of the synthesis",
  "output": "key findings, decisions, or explanations as a single string",
  "evidence": "concrete anchors: paths, snippets, commands, config keys",
  "learnings": "reusable knowledge: dead ends, wrong assumptions, couplings",
  "actionItems": ["concrete verifiable task 1", "concrete verifiable task 2"],
  "groundingScore": 0.0,
  "ungroundedClaims": ["any claim in output that lacks support in previous_findings"]
}`;
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

<previous_findings>
${stage1Output}
</previous_findings>

Return your synthesis as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}${guard}`;
  }
  return `${task}

A previous exploration stage gathered these raw findings:

<previous_findings>
${stage1Output}
</previous_findings>

Your job: synthesize these findings into a decision-useful report. You do NOT need to explore further — work with the findings above.

Return your synthesis as a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Rules:
- "status" is required and must be one of: ok, needs-work, blocked, exploratory.
- "summary" is required and should be one paragraph.
- "output" is required. Put the useful substance here.
- "evidence" is required. Include concrete anchors.
- "learnings" is required. Extract reusable knowledge.
- "actionItems" is required. Each item must be a concrete, verifiable task string.
- "groundingScore" is required. Rate from 0.0 to 1.0 how well each claim in "output" is supported by <previous_findings>. Be honest and strict.
- "ungroundedClaims" is required. List any claim in "output" that is not directly backed by <previous_findings>. Use an empty array if everything is grounded.
- Do NOT use markdown headings like "## Result" outside the JSON.${guard}`;
}

export function buildReviewPrompt(customPrompt?: string): string {
  if (customPrompt) return customPrompt + STAGE_AUDIT_GUARD;
  return `Review the code changes made in this session. Your job is to find issues the developer may have missed.

Instructions:
- Examine all changed files and recent edits
- Find bugs, edge cases, missing error handling, security concerns
- Check for style inconsistencies, naming issues, dead code
- Verify that no existing tests are broken
- Suggest concrete improvements with code snippets where helpful

Use this structure:

## Result
Summary of review: pass / needs-work / blocked. Key concerns in bullets.

## Issues Found
Each issue as: File, Line, Severity, Description, Fix suggestion.

## Suggestions
Improvements that aren't bugs: refactors, patterns, tests to add.

## Evidence
Files reviewed, diff locations, edge cases verified, assumptions checked.

Be direct. Flag real problems loudly. Don't praise trivial things.${STAGE_AUDIT_GUARD}`;
}

export function buildFileReviewPrompt(
  filePath: string,
  reportContent: string,
  referencedFiles: Record<string, string>,
): string {
  const auditSuffix = STAGE_AUDIT_GUARD;
  const fileList = Object.keys(referencedFiles);
  const filesSection = fileList.length > 0
    ? fileList.map(f => {
        const content = referencedFiles[f];
        const truncated = content.length > 3000
          ? content.slice(0, 3000) + "\n\n... (truncated, full file is longer)"
          : content;
        return `### ${f}\n\`\`\`\n${truncated}\n\`\`\``;
      }).join("\n\n")
    : "(no referenced files found in the report)";

  const MAX_REPORT_INLINE_CHARS = 12000;
  const normalizedReport = reportContent.length > MAX_REPORT_INLINE_CHARS
    ? reportContent.slice(0, MAX_REPORT_INLINE_CHARS) + `\n\n... (truncated from ${reportContent.length} chars; read the full file for complete context)`
    : reportContent;

  return `Review the following report AND the actual code it references. Your job: compare what the report claims against what the code actually contains.

Report: ${filePath}

Instructions:
- Compare each claim in the report against the actual file contents below
- Find mismatches: things the report says were done but aren't in the code
- Find bugs: issues in the actual code that the report didn't catch
- Find gaps: report claims that lack corresponding implementation
- Check if Action Items marked done are genuinely resolved in the code
- Flag anything the report claims that contradicts the actual code

Use this structure:

## Result
Summary: pass / needs-work / blocked. Did the implementation match the report?

## Claims vs Code
For each key claim in the report, verify against the actual files. Format:
**Claim:** what the report says
**Reality:** what the code actually shows
**Verdict:** ✅ matched / ⚠️ partial / ❌ missing

## Bugs Found
Issues in the actual code (not report claims): File, Line, Severity, Description.

## Gaps
Things the report says are done but aren't reflected in code.

## New Action Items
List any new tasks surfaced by this review as checkboxes the main agent can act on.

- [ ] item 1
- [ ] item 2

## What's Missing
Considerations neither the report nor the code address.

---

<report>
${normalizedReport}
</report>

<actual-files>
${filesSection}
</actual-files>${auditSuffix}`;
}

export function buildDiffReviewPrompt(diffSpec: string, diffContent: string): string {
  const maxLen = 40000;
  const truncated = diffContent.length > maxLen
    ? diffContent.slice(0, maxLen) + `\n\n... (diff truncated for review — ${diffContent.length - maxLen} more chars)`
    : diffContent;

  return `Review the following code diff thoroughly. Find bugs, edge cases, missing error handling, security concerns, and gaps.

Diff: ${diffSpec}

Instructions:
- Examine every changed file and every changed line
- Find bugs introduced by these changes
- Check for missing error handling, null guards, edge cases
- Look for security concerns (injection, auth bypass, data leaks)
- Verify that changes don't break existing patterns or conventions
- Check for dead code, unused imports, leftover debug statements
- Suggest concrete fixes with code snippets where helpful

Use this structure:

## Result
Summary: pass / needs-work / blocked. Key concerns in bullets.

## Issues Found
Each issue as: File, Line, Severity, Description, Fix suggestion.

## New Action Items
List any fixes needed as checkboxes.

- [ ] item 1
- [ ] item 2

## Suggestions
Improvements that aren't bugs: refactors, tests, patterns.

---

<diff>
${truncated}
</diff>${STAGE_AUDIT_GUARD}`;
}

export function buildYoloReviewSnapshot(baseSnapshot: string, reportContent: string, round: number): string {
  const task = `YOLO review-fix round ${round}. Review the following cdev report against the actual code and determine whether the reported issues have been resolved.

Report:\n${reportContent}`;
  return appendTaskToSessionJsonl(baseSnapshot, task);
}

export function buildYoloFixTask(originalTask: string, reviewText: string, round: number): string {
  return `Fix the following issues from code review (round ${round}):

${reviewText}

Original task: ${originalTask}`;
}
