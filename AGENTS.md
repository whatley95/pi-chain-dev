# pi-chain-dev agent guide

This repo is the **pi-chain-dev** Pi extension: a two-stage scout→forge runner for the Pi coding agent CLI.

## How to work in this repo

### cdev workflow

Use the simplest cdev mode that fits the task. Do not default to verify mode.

- **Small question / single file check** → `/cdev quick <task>` or `/cdev fast <task>`
- **Code change / feature / investigation** → `/cdev <task>` (scout + forge, single scout)
- **High-confidence cross-check** → `/cdev verify <task>` only when asked
- **After code changes** → `/cdev review` or `/cdev review changes`
- **Before big refactor** → `/cdev plan <task>`

### Quality gates

Before committing, run:

```bash
npm test
npm run lint
npm run typecheck
```

All three must pass. Tests are in `test/**/*.test.ts` and run with Node's built-in test runner via `tsx`.

### Code conventions

- Source files live in `src/`. Tests live in `test/`.
- Prefer editing existing files over creating new ones.
- Follow the existing style: no unnecessary comments, strict TypeScript, named exports.
- Do not commit `.pi/` — it is already gitignored.
- Do not add documentation files unless explicitly asked.

### Useful commands

| Command | Purpose |
|---|---|
| `npm test` | Run all tests |
| `npm run lint` | ESLint on `src` and `test` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Update build date and compile |
| `npm run setup-hook` | Install pre-commit build-date hook |

### Project structure

- `src/index.ts` — extension entry point; registers tool and commands.
- `src/tool.ts` — cdev tool execution and dispatch.
- `src/commands/` — `/cdev`, `/cdev-model`, `/cdev-scan`, `/cdev-memory`, `/cdev-map`.
- `src/fork-orchestrator.ts` — two-stage runner, verify, parallel, YOLO loops.
- `src/fork-stage.ts` — child Pi process spawning and session handling.
- `src/extension-context.ts` — snapshots, cost tracking, status helpers.
- `src/prompts.ts` — stage prompts.
- `src/types.ts` — config and result types.

When making changes, look for existing patterns in nearby files and mimic them.
