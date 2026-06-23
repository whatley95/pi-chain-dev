# Main-Agent Strategic Execution Flow for cdev

This document defines how the parent Pi agent should use `cdev` to stay
strategic, avoid duplicate work, and keep the user in control.

## 1. Decide Whether to Fork

Before using the `cdev` tool, ask:

- **Does this need more than 3-4 file reads?** → Use `cdev`.
- **Is this a pure code/edit task with a clear plan?** → Do it directly.
- **Have we explored this topic before?** → `recall=<topic>` first.
- **Is the session getting large?** → Strongly suggest `/compact` first if ≥40 messages. cdev itself adds messages, and a large session degrades context quality.
- **Would this exceed the cost budget?** → The tool will block; proactively mention the estimate.

## 2. Choose the Right Mode

| Goal | Mode | Notes |
|------|------|-------|
| Research / understand code | `cdev <task>` | Scout + forge, structured report |
| Quick grep/trace | `cdev quick <task>` | Scout only, raw findings |
| High-stakes investigation | `cdev verify <task>` | Scout ×2 + forge, ~2× stage-1 cost |
| Plan before a refactor | `cdev plan <task>` | Scout + planner forge: risks, files, steps, tests |
| Review recent changes | `cdev review` | Session-level review |
| Review a specific file | `cdev review reviewFile=<path>` | Standalone report, **never modifies the file** |
| Review a diff | `cdev review diffSpec=<range>` | Git/SVN diff review |
| Auto review-fix loop | `cdev yolo <task>` | Scout + forge + review-fix rounds. Use only when task is scoped, tests exist, and budget is healthy |

## 3. Read the Report, Then Act

After `cdev` returns:

1. Read the saved report path shown in the output.
2. Check the **Grounding** score and any **ungrounded claims**. If grounding is low, tell the user what is unverified and ask for clarification before acting.
3. Summarize the **key findings** to the user in 1-3 bullets.
4. Surface **ambiguities** and **open questions** back to the user — do not guess.
5. Turn **action items** into a concrete plan and ask the user before editing.

If the report has a **plan** section, use it as the implementation roadmap but still confirm risky or ungrounded steps with the user.

## 4. Implement and Verify

1. Make the changes yourself (cdev stages never edit code).
2. Update the report file: check off completed action items, add implementation notes.
3. Re-run review if the change is significant: `cdev({ review: true, reviewFile: "<changedFile>" })` or `/cdev review` after a session-level change.
4. Run relevant tests/compilation and report results.

## 5. Update Memory

After a successful exploration:

- `cdev recall <topic>` later to retrieve findings without re-exploring.
- If `recall` shows **stale** findings, run `cdev quick <topic>` on the changed files to refresh them cheaply instead of doing a full explore.
- Use `/cdev memory refresh <topic>` when files in that topic have changed.
- Clear stale memory with `/cdev memory clear` or `/cdev memory forget <topic>`.

## 6. Cost Hygiene

- Check `/cdev status` when in doubt.
- Prefer `quick` for narrow lookups.
- Use `verify` only when accuracy is worth the extra cost.
- Stop YOLO loops early if reviews keep failing — escalate to the user instead of burning budget.

## Anti-Patterns

- **Do not** ask cdev to implement changes; it is audit-only.
- **Do not** run file review on source files and assume the file was modified; review only writes reports.
- **Do not** ignore low `groundingScore` or `ungroundedClaims`; ask for clarification.
- **Do not** re-explore a topic without checking `recall` first.
