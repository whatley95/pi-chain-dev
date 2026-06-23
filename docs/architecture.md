# pi-chain-dev Architecture

## Overview

`pi-chain-dev` is a Pi extension that delegates work to child Pi processes using a
two-stage model: a cheap **scout** explores, and a more capable **forge** synthesizes
the findings into a decision-useful report. Optional verify, review, and YOLO loops
add accuracy and automation while keeping the operator in control.

## Module Map

```text
src/
├── index.ts                # Pi extension entry point and command registration
├── commands/cdev.ts        # /cdev command dispatcher, status, YOLO toggle
├── commands/cdev-model.ts  # Interactive model/profile picker
├── tool.ts                 # Pi tool: executeCdevTool, YOLO invocation, report writing
├── extension-context.ts    # Session snapshots, cost tracking/estimation, output formatting
├── config.ts               # Load and normalize settings.json configuration
├── types.ts                # Shared TypeScript types and guards
├── runner.ts               # Thin barrel re-exporting the public runner API
├── runner-cli.ts           # Parse CLI args inherited from the parent Pi process
├── runner-events.ts        # Thin barrel for Pi JSON event helpers
├── events.ts               # Process Pi JSON-mode events
├── messages.ts             # Assistant message sanitization and final text extraction
├── progress.ts             # Activity/progress formatting
├── stable-stringify.ts     # Deterministic JSON stringification
├── usage.ts                # Shared usage/cost aggregation
├── prompts.ts              # All stage/review/YOLO prompt builders + prompt version
├── json-extract.ts         # Brace-balanced JSON extraction, stage parsers
├── fork-stage.ts           # Temp sessions, sanitization/redaction, Pi child process runner
├── fork-orchestrator.ts    # runAutoFork, runYoloLoop, findings merging/validation
├── review.ts               # runCdevReview, file review, diff review
├── report.ts               # Safe report filename handling and report writing
├── path-guards.ts          # isPathUnderCwd path safety helper
├── memory.ts               # Project-level memory index and retrieval
├── logger.ts               # Structured JSONL debug/error logging
├── env.ts                  # Build child process environment
├── build-date.ts           # Build timestamp (auto-updated by hook)
└── pi-stubs.ts             # Local type stubs for runtime Pi peer dependencies
```

## Data Flow

1. **Trigger**: User runs `/cdev <task>`, `/cdev review`, `/cdev yolo <task>`, or the
   main agent calls `executeCdevTool`.
2. **Snapshot**: `extension-context.ts` serializes the current Pi session into JSONL
   and estimates size/cost.
3. **Budget check**: `checkCostBudget` blocks the fork if it would exceed
   `maxForkCost` or `maxSessionCost`.
4. **Stage 1 (scout)**: `fork-orchestrator.ts` runs one or two scout passes with a
   read-only tool allowlist (`--tools read,bash,ls,grep,find,cat`).
5. **Merge/validate**: Findings are merged, deduplicated, and checked for confidence.
   Sparse/low-confidence results trigger a re-explore.
6. **Stage 2 (forge)**: The forge stage receives the merged findings and returns a
   structured `Stage2Report` with a grounding score.
7. **Report**: `report.ts` writes a markdown report to `.pi/cdev/reports/` and
   optionally appends to an existing file.
8. **Memory**: Optional project-level memory records the topic, findings, and file
   fingerprints for cross-session retrieval.
9. **YOLO loop**: If enabled, review and fix rounds run until the review passes,
   `maxRounds` is reached, or the budget is exhausted.

## Security Boundaries

- All report filenames are sanitized to basenames and rejected if they would write
  outside `.pi/cdev/reports/`.
- File review reads only paths confirmed by `isPathUnderCwd`.
- Session snapshots are redacted for API keys, hex/base64 secrets, and `--api-key`
  arguments before being written to temp files.
- Scout mode uses a read-only tool allowlist; forge/review stages run with
  `--no-tools` by default.
- Temp session directories are created with mode `0o600` and removed in `finally`.

## Cost Controls

- `maxForkCost`: per-fork cost ceiling.
- `maxSessionCost`: per-session ceiling for all cdev forks.
- Alerts at 80% (warning) and 95% (critical) of `maxSessionCost`.
- Cost estimates include stage 1, optional verify stage 1b, and stage 2.
- YOLO loops check the per-round budget before each iteration.

## Testing

Tests live in `test/` and run with Node's built-in test runner via `tsx`:

```bash
npm test
npm run test:watch
```

Lint and typecheck:

```bash
npm run lint
npm run typecheck
```

Key test categories:

- Direct module tests for `prompts.ts`, `json-extract.ts`, `fork-stage.ts`,
  `path-guards.ts`, `budget.test.ts`, and `logger.test.ts`.
- Integration tests for `runStageCore` child-process failure modes.
- Regression tests for redaction, session sanitization, and cost alerts.

## Build Automation

- `npm run build` updates `src/build-date.ts` and compiles TypeScript.
- `npm run setup-hook` installs a pre-commit hook that stages `src/build-date.ts`.
- The hook script and build-date updater are CommonJS (`.cjs`) so they work even
  when `.git/hooks/` is treated as CommonJS via an auto-generated `package.json`.

## Configuration

Configuration is read from `settings.json` under the `pi-chain-dev` key. Key fields
include `stage1`, `stage1b`, `stage2`, `review`, `autoVerify`, `maxForkCost`,
`maxSessionCost`, `extensions`, `environment`, and `yolo`. See `README.md` for the
full reference.
