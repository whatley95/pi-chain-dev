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
  "openQuestions": ["optional questions for the main agent"],
  "coverage": {
    "filesInspected": 0,
    "filesCited": 0,
    "commandsRun": 0,
    "unreadLikelyFiles": 0
  }
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
- "coverage" is required. Provide honest counts.
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings" outside the JSON.
- Estimate "coverage" honestly: count files you inspected, files cited in findings, commands you ran, and likely relevant files you did NOT read.${guard}`;
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
  "ungroundedClaims": ["any claim in output that lacks support in previous_findings"],
  "coverage": {"filesInspected": 0, "filesCited": 0, "commandsRun": 0, "unreadLikelyFiles": 0},
  "qualityScore": 0.0,
  "qualityNotes": "brief assessment of evidence density, actionability, and unresolved questions"
}`;
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

<previous_findings>
${stage1Output}
</previous_findings>

Return a single JSON object matching this schema. Be strict about grounding every claim in the previous findings.${guard}`;
  }
  return `${task}

A scout stage gathered these findings:

<previous_findings>
${stage1Output}
</previous_findings>

Your job: synthesize the findings into a concise, decision-useful report. Do NOT gather new evidence or run tools. Do NOT write code.

Return a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Rules:
- "status" is required: ok / needs-work / blocked / exploratory.
- "summary" is required. One paragraph.
- "output" is required. This is the main answer for the user.
- "evidence" is required. Include concrete anchors.
- "learnings" is required. Extract reusable knowledge.
- "actionItems" is required. Each item must be a concrete, verifiable task string.
- "groundingScore" is required. Rate from 0.0 to 1.0 how well each claim in "output" is supported by <previous_findings>. Be honest and strict.
- "ungroundedClaims" is required. List any claim in "output" that is not directly backed by <previous_findings>. Use an empty array if everything is grounded.
- "coverage" is required. Copy or refine the scout coverage counts.
- "qualityScore" is required. Rate 0.0-1.0 the overall report quality: evidence density, actionability of actionItems, clarity of open questions, reuse of memory.
- "qualityNotes" is required. One-sentence explanation of the qualityScore.
- Do NOT use markdown headings like "## Result" outside the JSON.${guard}`;
}

export function buildPlanPrompt(task: string, stage1Output: string, customPrompt?: string): string {
  const jsonSchema = `{
  "status": "ok|needs-work|blocked|exploratory",
  "summary": "one-paragraph summary of the plan",
  "risks": ["risk 1", "risk 2"],
  "files": {
    "read": ["files already inspected"],
    "toModify": ["files that will need changes"],
    "toCreate": ["files that may need to be created"]
  },
  "steps": [
    {"order": 1, "description": "what to do", "verification": "how to confirm it works"}
  ],
  "checklist": [
    {"order": 1, "task": "concrete edit to make", "verification": "exact command or check to run after", "grounded": true}
  ],
  "testCommands": ["command to run after implementation"],
  "openQuestions": ["optional questions for the main agent"],
  "groundingScore": 0.0,
  "ungroundedClaims": ["any claim that lacks support in scout findings"],
  "coverage": {"filesInspected": 0, "filesCited": 0, "commandsRun": 0, "unreadLikelyFiles": 0},
  "qualityScore": 0.0,
  "qualityNotes": "brief quality assessment"
}`;
  if (customPrompt) {
    return `${customPrompt}

Task: ${task}

<scout_findings>
${stage1Output}
</scout_findings>

Return a single JSON object matching this schema. Do not implement any code; produce only an implementation plan. The "checklist" must be the main agent's execution roadmap.`;
  }
  return `${task}

A scout stage gathered these findings:

<scout_findings>
${stage1Output}
</scout_findings>

Your job: produce an implementation plan based on the findings above. Do NOT write code. Output only a plan.

Return a single JSON object matching this schema (no markdown fences, no extra prose):
${jsonSchema}

Rules:
- "status" is required.
- "risks" is required. List concrete risks and how to mitigate them.
- "files" is required. Separate read/verified files from files that need changes or creation.
- "steps" is required. Each step must have order, description, and verification. Keep steps high-level.
- "checklist" is required. It must be an ordered list of concrete, executable tasks the main agent can check off one by one.
  - Each checklist item must include: "task" (concrete edit), "verification" (exact command or check), and "grounded" (boolean — true only if supported by scout findings).
  - If an item is not grounded, set "grounded": false and explain why in "openQuestions".
- "testCommands" is required. Include commands that verify the whole change (tests, compile, lint).
- "groundingScore" and "ungroundedClaims" are required. Be strict.
- "coverage", "qualityScore", "qualityNotes" are required.`;
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
Each issue MUST include:
- **File:** relative path
- **Line:** line number or snippet range
- **Severity:** critical / high / medium / low
- **Description:** concrete problem
- **Reproduction/Logic:** how to trigger or why it is wrong
- **Fix suggestion:** concrete code or approach

Vague issues without file/line/evidence are not acceptable.

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
pass / needs-work / blocked + concise summary

## Mismatches
Report claims vs actual code.

## Bugs Found
Issues in the actual code.

## Gaps
Report claims without implementation.

## Evidence
Files/lines reviewed.

Report content:
${normalizedReport}

Referenced code files:
${filesSection}${auditSuffix}`;
}

export function buildDiffReviewPrompt(diffSpec: string, diffContent: string): string {
  const auditSuffix = STAGE_AUDIT_GUARD;
  const MAX_DIFF_CHARS = 30000;
  const normalizedDiff = diffContent.length > MAX_DIFF_CHARS
    ? diffContent.slice(0, MAX_DIFF_CHARS) + `\n\n... (truncated from ${diffContent.length} chars)`
    : diffContent;

  return `Review the following diff. Your job: find bugs, edge cases, missing tests, security issues, and regressions introduced by these changes.

Diff spec: ${diffSpec}

Instructions:
- Focus on what CHANGED, not pre-existing style debt unless it is directly worsened
- Check for missing error handling, unsafe assumptions, broken contracts
- Verify that tests/lint/typecheck would catch obvious regressions
- Flag any change that contradicts the stated intent

Use this structure:

## Result
pass / needs-work / blocked + concise summary

## Issues Found
Each issue MUST include file, severity, description, and fix suggestion.

## Suggestions
Non-blocking improvements.

## Evidence
Files and ranges reviewed.

Diff:
\`\`\`diff
${normalizedDiff}
\`\`\`${auditSuffix}`;
}

export function buildYoloReviewSnapshot(forkSessionSnapshotJsonl: string, reportContent: string, round: number): string {
  const base = forkSessionSnapshotJsonl || JSON.stringify({}) + "\n";
  const reportSection = `\n\nPrevious implementation report (YOLO review-fix round ${round}):\n${reportContent}`;
  return appendTaskToSessionJsonl(base, `Review the implementation report from YOLO review-fix round ${round}. Decide if it passes, needs work, or is blocked. Be specific about issues and fixes.` + reportSection);
}

export function buildYoloFixTask(originalTask: string, reviewText: string, round: number): string {
  return `The previous implementation attempt for "${originalTask}" was reviewed. Address the issues below and produce an updated implementation.

Review feedback (round ${round}):
${reviewText}

Instructions:
- Fix the issues identified in the review.
- Preserve working behavior; do not introduce regressions.
- Return the full updated implementation/report.`;
}

export function buildStage2FindingsPrompt(stage1Output: string, customPrompt?: string): string {
  if (customPrompt) return `${customPrompt}\n\n<previous_findings>\n${stage1Output}\n</previous_findings>`;
  return `Synthesize these scout findings into a concise report:

<previous_findings>
${stage1Output}
</previous_findings>`;
}
