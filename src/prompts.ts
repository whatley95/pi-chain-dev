import { appendTaskToSessionJsonl } from "./fork-stage.js";
import { loadProjectMap, summarizeMapForPrompt, formatSuggestedFiles, type ProjectMap, type ParallelSubTask } from "./project-map.js";

export const STAGE_AUDIT_GUARD = `\n\n⚠️ AUDIT ONLY — READ-ONLY AUDIT MODE. YOU MUST NOT CREATE, MODIFY, MOVE, COPY, OR DELETE ANY FILES OR DIRECTORIES.
- Do NOT run commands that write to disk (e.g., \`echo >\`, \`cat >\`, \`tee\`, \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`chmod\`, \`git add\`, \`git commit\`, \`npm install\`, \`ng generate\`, etc.).
- Do NOT use \`bash\` to create, modify, move, copy, or delete files or directories.
- Do NOT run build, install, generate, or scaffold commands that mutate the working directory.
- Your job is to INSPECT and REPORT only. If the task asks for implementation, describe what files would need to be created or changed and why, but do NOT create or modify them.
- Any claim that you created, modified, moved, copied, or deleted a file is false and violates these instructions.`;

const EFFICIENCY_RULES = `Efficiency rules (MANDATORY — minimize round-trips):
- **All \`bash\` commands must be READ-ONLY.** Never use \`bash\` to write, copy, move, delete, generate, or otherwise modify files or directories. No \`echo >\`, \`cat >\`, \`tee\`, \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`chmod\`, \`git add\`, \`npm install\`, \`ng generate\`, etc.
- **Use \`gatherCodeContext\` first for code lookup tasks.** It searches with rg, ranks files, and returns compact line-window snippets in one tool call. Prefer it over doing separate \`rg\` then \`read\` calls.
- **ALWAYS batch file reads. Never read files one at a time.** If you need more than one file, use the \`multiRead\` tool or issue multiple \`read\` calls in a single response. Pi executes them in parallel.
- **Minimum batch size**: Issue at least 3-5 files together whenever you need multiple files. Use \`multiRead\` for batches of 2-10 files, or issue multiple \`read\` calls. There is no benefit to reading them sequentially.
- **Prefer\`rg\`for discovery**: \`bash: rg -n "pattern" src/\` is faster than recursive \`grep\` and respects \`.gitignore\`. Use it to locate relevant files FIRST.
- **Read discovered files in parallel**: After locating files with \`rg\` / \`find\` / \`grep\`, use \`multiRead\` or issue all needed \`read\` calls in the SAME response.
- **Batch reads with\`cat\`when needed**: \`bash: cat src/a.ts src/b.ts src/c.ts\` reads many files in one tool call. Use this when \`read\` batching is inconvenient.
- **Use\`bash\`with globs for bulk inspection**: \`bash: cat src/**/*.ts | grep -n "pattern"\` reads many files in one tool call.
- **Single-file\`read\`is a last resort**: Only use \`read\` for exactly one specific, named file. For 2+ files, use \`multiRead\`, batch \`read\` calls, or use \`bash: cat ...\`.
- **Search before reading**: Run \`rg\` or \`grep\` first to locate relevant files, then read only the relevant ones in parallel.
- **Do NOT dump entire large files into evidence**: For files over ~200 lines, read only the relevant section (e.g., \`read path:100-150\`) or use \`bash: rg -n -A 10 -B 5 pattern path\`. Summarize the rest. Giant verbatim pastes waste tokens and may be truncated.`;

export function buildStage1Prompt(task: string, customPrompt?: string, editMode?: boolean, cwd?: string, subTask?: ParallelSubTask, quick?: boolean, map?: ProjectMap | null): string {
  const guard = editMode ? "" : STAGE_AUDIT_GUARD;
  const mapContext = cwd ? loadMapContext(cwd, map) : "";
  const startFiles = map ? formatSuggestedFiles(map, subTask ? subTask.focus : task) : "";
  const scopeHint = subTask?.scope?.length
    ? `\n\nFocus your exploration on these areas: ${subTask.scope.join(", ")}`
    : "";
  const focusTask = subTask ? subTask.focus : task;
  const quickGuard = quick
    ? "\n\nQUICK MODE — READ ONLY: You do not have tools to create, modify, or write files. Do NOT claim that any files were created, modified, or changed. Only report observations, findings, and evidence. If the task asks you to implement something, explain that quick mode cannot modify files and describe what would need to be done."
    : "";
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
    return `${customPrompt}${mapContext}${startFiles}${scopeHint}

Task: ${focusTask}

Return your findings as a single JSON object matching this schema (fenced JSON output, no extra prose):
${jsonSchema}

${EFFICIENCY_RULES}${guard}${quickGuard}

⚠️ ANTI-HALLUCINATION:
- "evidence" must be a verbatim snippet or exact command output you actually observed. Do NOT fabricate, guess, or paraphrase evidence.
- Do NOT claim you read a file unless you actually read it with a tool.
- Do NOT invent file paths, command outputs, or configuration values.
- If uncertain, set confidence to "low" and explain what you did NOT verify in the observation.`;
  }
  if (quick) {
    return `${focusTask}${mapContext}${startFiles}${scopeHint}

QUICK EXPLORATION MODE. Read-only. Gather just enough evidence, then stop.

Use the fastest path:
- Prefer gatherCodeContext for search + snippets in one call.
- Use multiRead only when full-file context is needed.
- Use rg for custom searches.
- Do not modify files or run write/build/install commands.

Return only fenced JSON matching this schema:
${jsonSchema}

Rules:
- Keep findings concise: usually 3-6 high-signal findings.
- Evidence must be exact observed snippets or command output.
- If uncertain, use confidence "low" and say what was not verified.
- Do not add prose outside the JSON.${guard}${quickGuard}`;
  }
  return `${focusTask}${mapContext}${startFiles}${scopeHint}

You are in EXPLORATION MODE. Your job is to gather information, not to write a final report.

Instructions:
- Explore thoroughly using available tools (gatherCodeContext, read, bash, ls, grep, rg, find, cat, multiRead). Prefer gatherCodeContext for search+snippet gathering, then multiRead for full-file follow-up.
- Gather concrete evidence: file contents, command outputs, config values
- Return your findings as a single JSON object matching this schema (fenced JSON output, no extra prose):
${jsonSchema}

${EFFICIENCY_RULES}
- Stop exploring once you have enough evidence to answer the task.

Rules:
- "summary" is required and must be one sentence.
- "findings" is required. Each finding must have "observation" and "confidence".
- "file" and "evidence" are optional but strongly preferred when applicable.
- "evidence" must be concise: at most 4-6 lines or ~400 characters per finding. Quote only the exact lines that support the observation.
- "deadEnds", "assumptions", "openQuestions" are optional.
- "coverage" is required. Provide honest counts.
- Stop adding findings once you have enough to answer the task. Aim for 5-10 high-quality findings, not dozens.
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings" outside the JSON.
- Estimate "coverage" honestly: count files you inspected, files cited in findings, commands you ran, and likely relevant files you did NOT read.
- "evidence" must be a verbatim snippet or exact command output you actually observed. Do NOT fabricate, guess, or paraphrase evidence.
- Do NOT claim you read a file unless you actually read it with a tool.
- If uncertain, set confidence to "low" and explain what you did NOT verify in the observation.${guard}${quickGuard}`;
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

Return a single JSON object matching this schema (fenced JSON output, no extra prose):
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

Return a single JSON object matching this schema (fenced JSON output, no extra prose):
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

export function buildResearchPrompt(task: string, customPrompt?: string, cwd?: string): string {
  const mapContext = cwd ? loadMapContext(cwd) : "";
  const jsonSchema = `{
  "summary": "one-sentence summary of the issue and what you found",
  "findings": [
    {
      "file": "optional relative file path",
      "observation": "concrete observation about the issue",
      "evidence": "supporting snippet, command output, or value",
      "confidence": "high|medium|low"
    }
  ],
  "decision": "your recommended decision or next step for the main agent",
  "deadEnds": ["optional paths that did not pan out"],
  "assumptions": ["optional assumptions made"],
  "openQuestions": ["optional questions the main agent must resolve"],
  "coverage": {
    "filesInspected": 0,
    "filesCited": 0,
    "commandsRun": 0,
    "unreadLikelyFiles": 0
  }
}`;

  const base = `You are in RESEARCH MODE. Investigate the issue thoroughly using available tools (gatherCodeContext, read, bash, ls, grep, rg, find, cat, multiRead). Prefer \`gatherCodeContext\` for repo search plus compact snippets, \`rg\` for custom searches, \`multiRead\` for reading multiple discovered files at once, and \`bash: cat ...\` to batch-read files. Do NOT implement, modify, or write any code. Do NOT create, modify, move, copy, or delete files or directories. All \`bash\` commands must be READ-ONLY.

Issue: ${task}${mapContext}

Return your findings as a single JSON object matching this schema (fenced JSON output, no extra prose):
${jsonSchema}

${EFFICIENCY_RULES}

Rules:
- "summary" is required and must be one sentence.
- "findings" is required. Each finding must have "observation" and "confidence".
- "decision" is required. State the recommended next step or resolution clearly.
- "file" and "evidence" are optional but strongly preferred when applicable.
- "deadEnds", "assumptions", "openQuestions" are optional.
- "coverage" is required. Provide honest counts.
- Do NOT write structured sections like "Result", "Output", "Evidence", or "Learnings" outside the JSON.
- "evidence" must be a verbatim snippet or exact command output you actually observed. Do NOT fabricate, guess, or paraphrase evidence.
- Do NOT claim you read a file unless you actually read it with a tool.
- If uncertain, set confidence to "low" and explain what you did NOT verify in the observation.`;

  if (customPrompt) {
    return `${customPrompt}\n\n${base}`;
  }
  return base;
}

export function buildAdvisorPrompt(question: string, scoutFindings?: string, customPrompt?: string, cwd?: string): string {
  const mapContext = cwd ? loadMapContext(cwd) : "";
  const base = `You are an ADVISOR. The main agent is stuck or needs help with a difficult decision. ${scoutFindings ? "A scout has already gathered relevant project data below." : "Use your knowledge and any available tools to investigate if needed."} Do NOT implement or edit code. Do NOT create, modify, move, copy, or delete any files or directories. All \`bash\` commands must be READ-ONLY. Give a clear, concise recommendation the main agent can act on.

Question: ${question}${mapContext}${scoutFindings ? `\n\n<scout_findings>\n${scoutFindings}\n</scout_findings>` : ""}

Return your advice as a single JSON object matching this schema (fenced JSON output, no extra prose):
{
  "summary": "one-sentence summary of the situation",
  "recommendation": "your concrete recommendation or next step",
  "reasoning": "brief reasoning with concrete anchors when possible",
  "confidence": "high|medium|low",
  "openQuestions": ["optional questions the main agent must resolve"],
  "actionItems": ["concrete verifiable tasks the main agent should do next"]
}

Rules:
- "summary" is required and must be one sentence.
- "recommendation" is required. Be direct and actionable.
- "reasoning" is required. Cite files, commands, or evidence when available.
- "confidence" is required.
- "openQuestions" and "actionItems" are required (use empty arrays if none).`;

  if (customPrompt) {
    return `${customPrompt}\n\n${base}`;
  }
  return base;
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
        const safe = truncated.replace(/```/g, "` ` `");
        return `### ${f}\n\`\`\`\n${safe}\n\`\`\``;
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

export function buildYoloFixTask(originalTask: string, reviewText: string, round: number, mode: "manual" | "propose" | "auto" = "manual"): string {
  if (mode === "auto") {
    return `The previous implementation attempt for "${originalTask}" was reviewed. Address the issues below and produce an updated implementation.

Review feedback (round ${round}):
${reviewText}

Instructions:
- Fix the issues identified in the review.
- Preserve working behavior; do not introduce regressions.
- You may edit files directly to apply fixes.
- Return a summary of what you changed.`;
  }
  if (mode === "propose") {
    return `The previous implementation attempt for "${originalTask}" was reviewed. Produce a concrete fix plan for the issues below. Do NOT edit files.

Review feedback (round ${round}):
${reviewText}

Instructions:
- Output a step-by-step fix plan with specific file paths and code snippets.
- Include a verification command for each change.
- The main agent will apply your plan; do not modify files yourself.`;
  }
  return `The previous implementation attempt for "${originalTask}" was reviewed. Provide clear, actionable instructions so the main agent can fix the issues below.

Review feedback (round ${round}):
${reviewText}

Instructions:
- List each issue with file path, line number or snippet, and exact fix instructions.
- Include a verification command for each fix.
- Do NOT edit files. The main agent will apply changes.`;
}

const SCOUT_MAP_MAX_CHARS = 8_000;

function loadMapContext(cwd: string, map?: ProjectMap | null): string {
  try {
    const resolved = map ?? loadProjectMap(cwd);
    if (resolved) {
      const summary = summarizeMapForPrompt(resolved);
      // summarizeMapForPrompt already applies a tiered 12k truncation; we only
      // apply a small extra cap here to keep token costs predictable.
      const maxChars = SCOUT_MAP_MAX_CHARS;
      return summary.length > maxChars
        ? `\n\n${summary.slice(0, maxChars)}\n... (project map truncated)`
        : `\n\n${summary}`;
    }
  } catch { /* ignore */ }
  return "";
}
