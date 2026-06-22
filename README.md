# pi-chain-dev

> Extension for **pi** — the Pi coding agent CLI.

Model-chained development — cheap model explores, powerful model synthesizes, memory remembers.

## Use case

> *Refactor the auth module to use middleware.*
>
> `cdev({ task: "explore auth module deps", recall: "auth" })`
>
> 🧠 memory hit — 3 previous forks already found JWT in middleware.ts, oauth.ts unused, rate‑limit bypass in login.ts. $0. No re‑exploration needed.
>
> With those findings, the LLM writes a plan, refactors the code, then:
>
> `cdev({ review: true })` — powerful model checks the diff, catches a broken import.
>
> Shipped in 2 turns. Total cost: $0.008.

Without cdev: reads 12 files one‑by‑one via parent model at $0.002 each, re‑discovers everything, misses the broken import. 8 turns. $0.035.

## Commands

| Command | What it does |
|---|---|
| `/cdev <task>` | Full two-stage: cheap model gathers evidence, powerful model writes structured report |
| `/cdev quick <task>` | Scout only — cheap model returns raw findings, skip forge (synthesis) |
| `/cdev verify <task>` | Scout ×2 with different temperatures + forge — higher accuracy, ~2× stage 1 cost |
| `/cdev review` | Forge only — reviews recent code changes for bugs, edge cases, and improvements |
| `/cdev auto on` | Auto-trigger mode — LLM proactively uses `cdev` for exploration tasks |
| `/cdev auto off` | Disable auto-trigger |
| `/cdev-model` | Interactive model picker — choose scout/forge models from configured providers |
| `/cdev scan` | Instant template scan — detects stack from package.json, generates prompts (free, no LLM) |
| `/cdev scan deep` | LLM-powered scan — reads actual codebase, writes truly custom prompts (scout → forge) |
| `/cdev prompts on` | Enable custom prompts (after scanning) |
| `/cdev prompts off` | Disable custom prompts — use generic ones instead |
| `/cdev history` | List recent cdev sessions (date, task, cost, status, model chain) |
| `/cdev history 3` | Show full detail for session #3 (models, tokens, cost) |
| `/cdev status` | Show full config overview — models, auto, prompts, memory, errors, cost |
| `/cdev info` | Alias for `/cdev status` |
| `/cdev recall` | List all memory topics with fork counts, file counts, age |
| `/cdev recall auth` | Show all findings for "auth" with freshness (✅ fresh / ⚠️ stale / ❓ unverified) |
| `/cdev view` | Alias for `/cdev recall` |
| `/cdev view auth` | Alias for `/cdev recall auth` |
| `/cdev clear` | Wipe all project memory |
| `/cdev memory clear` | Same as `/cdev clear` |
| `/cdev memory forget auth` | Remove one topic from memory |
| `/cdev memory merge` | Auto-merge similar memory topics |
| `/cdev memory on` | Enable project memory |
| `/cdev memory off` | Disable project memory (stops indexing + recall) |
| `/cdev clear error` | Wipe error log |

### Agent tool

The LLM can also call `cdev` via a registered tool — no typing commands:

| Param | Type | What it does |
|---|---|---|
| `task` | string | Full two-stage fork |
| `quick` | boolean | Scout only (raw findings, skip forge) |
| `verify` | boolean | Scout ×2 + forge (self-consistency, higher accuracy) |
| `review` | boolean | Forge only (code review, skip scout) |
| `recall` | string | Retrieve past findings from project memory (e.g. `"auth"`) — $0, no fork |
| `recall` | `""` (empty) | List all known topics |
| `effort` | `"fast"` \| `"balanced"` \| `"deep"` | Override model selection for this fork |

Auto-trigger mode tells the LLM to use the tool proactively. The agent also receives prompt guidelines:
- Use `recall=<topic>` before re-exploring — costs $0, avoids duplicate work
- Use `recall=""` to list all known topics when starting in a project
- Use `review:true` after significant code changes
- Use `quick:true` for quick file tracing
- Use `verify:true` for high-stakes exploration where accuracy matters more than speed or cost
- Prefer cdev over bash/grep for understanding relationships

## Project memory

After every fork, findings are indexed to `.pi/cdev/memory.json`. Cross-session — survives restarts.

### How it works

```
Fork completes
     │
     ├──► history.ts: saveSession()       → .pi/cdev/sessions/ (per-fork, 7-day purge)
     │
     └──► memory.ts: indexFindings()      → .pi/cdev/memory.json (permanent)
          │
          ├── extracts file paths from fork result (regex, 4 patterns)
          ├── computes SHA256 fingerprints for each referenced file
          ├── derives topic from task + file paths (heuristic, no LLM)
          └── upserts finding with fingerprints
```

### Staleness detection

Findings stored with file fingerprints. On recall, each referenced file is re-hashed:

```
  ✅ JWT in middleware.ts           → middleware.ts hash matches → fresh
  ⚠️ oauth.ts unused                → oauth.ts deleted → stale
  ❓ auth flow uses 3 providers     → no file snapshot → unverified
```

Memory output includes an explicit trust header the agent can't ignore:

```
── cdev memory: auth ──────────────

    🚦 MIXED: 1 stale — VERIFY before using | 2 fresh — trustworthy

  ✅ Jun 18  scout  flash→pro      $0.0120
     JWT in middleware.ts, verifySession in 12 places
  ⚠️ Jun 15  forge  flash           $0.0032
     oauth.ts is unused, 450 lines
     ↳ stale: src/auth/oauth.ts (deleted)
```

### Config

| Key | Type | Default | Description |
|---|---|---|---|
| `memory` | boolean | `true` | Enable/disable project memory |

Memory can be toggled: `/cdev memory on` / `/cdev memory off`. When off, no indexing occurs and recall returns disabled. Existing memory files are untouched.

## Error logging

All cdev errors are appended to `.pi/cdev/errors.jsonl` (JSONL, one record per line):

```jsonl
{"ts":"2026-06-21T15:30:00.000Z","context":"review-stage2","message":"Stage 2 failed: timeout","stack":"..."}
```

Logged for: tool crashes, review failures, full-mode failures, deep-scan failures, scan failures.

`/cdev status` shows error count if any exist. `/cdev clear error` wipes the log.

## How it works

### Full mode (`/cdev <task>`)

```
  /cdev explore auth
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT — cheap model (deepseek-v4-flash)     │
  │  Reads files, traces deps, gathers evidence  │
  │  Returns structured JSON findings:           │
  │  summary, findings[], deadEnds[],            │
  │  assumptions[], openQuestions[]              │
  └──────────────────┬───────────────────────────┘
                     │ validated findings
   ┌──────────────────▼───────────────────────────┐
   │  FORGE — powerful model (deepseek-v4-pro)    │
   │  Synthesizes into structured report          │
   │  Result / Output / Evidence / Learnings      │
   └──────────────────┬───────────────────────────┘
                      │ report
                      ▼
               PARENT reads report, decides, codes
```

If stage 1 output is invalid or empty, cdev retries the scout stage once automatically. If it still fails, cdev falls back to passing the raw text to forge rather than failing completely.

### Quick mode (`/cdev quick <task>`)

```
  Parent: "I need to find where auth middleware is used in every module"
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT only — cheap model                    │
  │  Traces files, returns structured findings   │
  │  No forge — just raw data                    │
  └──────────────────┬───────────────────────────┘
                     │ findings
                     ▼
              PARENT uses findings, continues
```

### Verify mode (`/cdev verify <task>`)

```
  Parent: "I need high-confidence exploration before a big refactor"
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT A — cheap model  (temperature 0.2)    │
  │  Returns structured findings                 │
  └──────────────────┬───────────────────────────┘
                     │
  ┌──────────────────┼───────────────────────────┐
  │  SCOUT B — same model (temperature 0.7)      │
  │  Returns structured findings                 │
  └──────────────────┬───────────────────────────┘
                     │ merge unique / deduplicate
                     ▼
  ┌──────────────────────────────────────────────┐
  │  FORGE — powerful model                      │
  │  Synthesizes merged findings into report     │
  └──────────────────┬───────────────────────────┘
                     │ report
                     ▼
              PARENT reads report, decides, codes
```

If one scout run produces invalid findings, cdev uses the valid run. If both are invalid, cdev falls back to the raw text from the first run.

### Review mode (`/cdev review`)

```
  PARENT writes code
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  REVIEW — forge model only (no scout)        │
  │  Examines diff + session context             │
  │  Finds bugs, edge cases, style issues        │
  │  Returns review: pass / needs-work / blocked │
  └──────────────────┬───────────────────────────┘
                     │
                     ▼
              PARENT fixes issues
```

### Auto-trigger mode

When `/cdev auto on` is active:
- Footer shows `⚡ CDEV AUTO`
- Every few turns, PI gets a gentle nudge to use `cdev` for exploration
- The LLM decides *when* to call `cdev` — you don't type `/cdev`
- Use `/cdev auto off` to disable

## Installation

### From GitHub (recommended)

```bash
# Install globally (user settings)
pi install git:github.com/whatley95/pi-chain-dev@main

# Or install to project settings (share with team)
pi install -l git:github.com/whatley95/pi-chain-dev@main

# Direct HTTPS URL also works
pi install https://github.com/whatley95/pi-chain-dev@main

# Try without permanently installing
pi -e git:github.com/whatley95/pi-chain-dev
```

### From local path

```bash
pi install /path/to/pi-chain-fork   # absolute path
pi install ./pi-chain-fork          # relative path
```

### Manual placement

Auto-discovered from `~/.pi/agent/extensions/pi-chain-dev/` — no install command needed if placed there.

### .gitignore / svn:ignore

Add `.pi/` to your project's ignore rules:

**Git:** add to `.gitignore`
```gitignore
.pi/
```

**SVN:** set on project root
```bash
svn propset svn:ignore '.pi' .
svn commit -m "Ignore cdev data"
```

Contains: sessions (`.pi/cdev/sessions/`), reports (`.pi/cdev/reports/`), memory (`.pi/cdev/memory.json`), error logs (`.pi/cdev/errors.jsonl`).

On `session_start`, cdev warns if `.gitignore`/`svn:ignore` is set up but `.pi/` is missing.

## Configuration

Set via `/cdev-model` (interactive) or directly in `~/.pi/agent/settings.json`:

```json
{
  "pi-chain-dev": {
    "stage1": {
      "provider": "opencode-go",
      "id": "deepseek-v4-flash",
      "thinking": "minimal"
    },
    "stage2": {
      "provider": "opencode-go",
      "id": "deepseek-v4-pro",
      "thinking": "xhigh"
    },
    "auto": false,
    "promptsEnabled": true,
    "memory": true,
    "offline": true,
    "costFooter": true
  }
}
```

### Config keys

| Key | Type | Default | Description |
|---|---|---|---|
| `stage1.provider` | string | _required_ | Provider for scout (exploration) |
| `stage1.id` | string | _required_ | Model ID for scout |
| `stage1.thinking` | `off` — `xhigh` | `minimal` | Thinking level for scout |
| `stage2.provider` | string | _required_ | Provider for forge (synthesis/review) |
| `stage2.id` | string | _required_ | Model ID for forge |
| `stage2.thinking` | `off` — `xhigh` | `xhigh` | Thinking level for forge |
| `auto` | boolean | `false` | Auto-trigger mode (LLM proactively uses cdev) |
| `promptsEnabled` | boolean | `true` | Enable/disable custom prompts |
| `prompts.explore` | string | — | Custom scout exploration prompt |
| `prompts.synthesize` | string | — | Custom forge synthesis prompt |
| `prompts.review` | string | — | Custom review prompt |
| `memory` | boolean | `true` | Enable/disable project-level memory |
| `signature` | string | `"whatley.xyz"` | Override status signature |
| `offline` | boolean | `true` | Force `PI_OFFLINE=1` for child processes |
| `costFooter` | boolean | `true` | Show cdev cost in footer |
| `maxForkCost` | number | `0` | Max cost (USD) for a single fork. `0` = unlimited |
| `maxSessionCost` | number | `0` | Max total cost (USD) for cdev in the current session. `0` = unlimited |

## Recommended model pairing

| Scout (explore) | Forge (synthesize / review) |
|---|---|
| `deepseek-v4-flash` | `deepseek-v4-pro` |
| `gpt-5-mini` | `claude-sonnet-4-5` |
| `gemini-2.0-flash` | `gemini-2.5-pro` |

**Key principle**: Different model for review than the one you code with — catches blind spots.

## Full workflow

```
/cdev scan                                # quick template scan (free, instant)
  or
/cdev scan deep                           # LLM reads codebase, writes truly custom prompts

/cdev auto on                             # enable auto-trigger

Ask: "Refactor the auth module to use middleware"

LLM: calls cdev({ task: "explore auth module deps" })
     → Scout: custom NestJS+Prisma prompt — only traces guards, modules, queries
     → Forge: custom synthesis prompt — ordered plan with breakage risks

LLM: reads report, decides approach, writes code

LLM: needs follow-up → calls cdev({ task: "trace auth middleware imports", quick: true })
     → Scout only: returns raw file paths
     → Cheaper, faster

/cdev review                               # or LLM calls cdev({ review: true })
     → Forge only: custom review prompt — checks NestJS-specific issues
     → Pass / needs-work / blocked, specific issues

LLM / you: fix issues, re-review if needed
```

## Stack detection

### `/cdev scan` — Template (free, instant)

Reads `package.json`, config files, and project structure to detect stack from 40+ pre-coded patterns:

- **Framework**: NestJS, Next.js, React, Vue, Angular, Express, Fastify, Koa, SvelteKit, Nuxt, Remix, Astro
- **ORM**: Prisma, TypeORM, Drizzle, Mongoose, Sequelize, Knex
- **Auth**: JWT, Passport, NextAuth, Clerk, Lucia
- **Testing**: Jest, Vitest, Mocha, Cypress, Playwright
- **Validation**: Zod, class-validator, Joi, Yup, Valibot
- **Styling**: Tailwind, styled-components, Emotion, Sass, Shadcn/ui, Radix, Mantine, Chakra, Ant Design
- **Build**: Vite, Webpack, tsup, esbuild, Rollup
- **State**: Zustand, Redux, Jotai, MobX, Pinia, TanStack Query
- **DB**: PostgreSQL, MySQL, MongoDB, Redis, SQLite (from docker-compose.yml + Prisma schema)
- **Monorepo**: Turborepo, Nx, Lerna

Generates stack-specific, focused prompts automatically. Accuracy: ~90% stack detection, ~60% prompt relevance.

### `/cdev scan deep` — LLM (paid, ~30s)

Uses the full two-stage pipeline to read your actual codebase and write prompts tailored to YOUR conventions, naming patterns, and architecture:
- Scout (cheap model): explores source files, maps patterns, gathers evidence
- Forge (powerful model): synthesizes findings into truly custom prompts
- Accuracy: ~99% stack detection, ~85% prompt relevance

Edit `.pi/settings.json` anytime to tune prompts from either scan.

## Fallback to pi-fork

If scout/forge aren't configured, pi-chain-dev falls back to `pi-fork`'s effort profiles:
- `fast` → scout, `deep` → forge

## Project structure

```
pi-chain-dev/
├── src/
│   ├── index.ts              # Extension entry point — registers cdev tool + commands
│   ├── tool.ts               # cdev tool execution (recall/review/fork)
│   ├── commands/
│   │   ├── cdev.ts           # /cdev command + lifecycle handlers
│   │   └── cdev-model.ts     # /cdev-model interactive model picker
│   ├── extension-context.ts  # Shared helpers, snapshots, cost footer, profiles
│   ├── runner.ts             # Two-stage fork runner + review mode
│   ├── history.ts            # Session telemetry — save, list, purge (7 days)
│   ├── memory.ts             # Project memory — cross-session findings, staleness
│   ├── scan.ts               # Project scanner — stack detection + prompts
│   ├── types.ts              # Type definitions
│   ├── config.ts             # Configuration loading
│   ├── env.ts                # Child environment builder
│   ├── runner-events.ts      # JSON line parsing from child processes
│   └── runner-cli.ts         # CLI arg inheritance
├── test/                     # Unit tests
└── README.md
```

## Status footer

When `costFooter: true`, the status bar shows a combined compact line:

```
  ⚡ cdev  📋  +$0.0040          ← auto on, prompts on, total cost
  cdev                           ← everything off, no cost
  ⚡ cdev  📋✕  +$0.0020         ← auto on, prompts off, cost
  🧠 3 topics  /cdev recall      ← memory has 3 topics
```

All managed via single key `"cdev-cost"`. Shows cost across current session.

## Structured findings

Stage 1 now returns structured JSON findings. This makes stage 2 synthesis more reliable and enables validation + merging.

```json
{
  "summary": "Auth uses JWT middleware plus Redis sessions",
  "findings": [
    {
      "file": "src/auth/middleware.ts",
      "observation": "JWT verification happens here",
      "evidence": "verify(token, JWT_SECRET)",
      "confidence": "high"
    }
  ],
  "deadEnds": ["looked for oauth1 usage — none found"],
  "assumptions": ["JWT_SECRET is set in env"],
  "openQuestions": ["how are refresh tokens rotated?"]
}
```

Each finding has an optional `file`, `evidence`, and `confidence` (`high`/`medium`/`low`).

## Cost budgeting

Set per-fork and per-session cost limits in settings:

```json
{
  "pi-chain-dev": {
    "maxForkCost": 0.05,
    "maxSessionCost": 0.50
  }
}
```

- `maxForkCost` blocks a single fork if its estimated cost would exceed the limit.
- `maxSessionCost` blocks a fork if the running session total + estimated cost would exceed the limit.
- `0` means unlimited (default).

When a limit is hit, cdev returns an error immediately without spawning models.

## Streaming progress

Long-running forks now emit live activity updates. The progress widget shows the current stage and latest activity, e.g.:

```
🔍 Scout exploration…  bash: running
🔍 Scout exploration…  read src/auth/middleware.ts
🔍 Scout exploration…  usage: 1,240 tokens, $0.0004
⚒️ Forge synthesis…    assistant responding...
```

This is automatic — no config needed.

## Report diffs

Each cdev session now stores the full result text. When you re-run a similar task, cdev compares the new report to the most recent previous report on that task and shows a diff:

```
📊 Changes vs previous report

### New
+ added a new auth middleware file
+ JWT secret now read from env

### Removed / Changed
- old session cookie approach
```

This makes it easy to see what changed between explorations.

## Session history

Forks recorded to `.pi/cdev/sessions/<id>.json`. Auto-purged after 7 days.

`/cdev history` lists all sessions with date, cost, mode, and model chain (e.g. `flash→pro`).

`/cdev history <n>` shows full detail: task, models, tokens, cost, exit codes, error messages.

## /cdev status output

```
── cdev status ─────────────────────────────────────

  👤 whatley.xyz

  Current model:    opencode-go:deepseek-v4-pro     ← your Pi /model
  Scout:  opencode-go:deepseek-v4-flash  •  minimal   ← exploration
  Forge:  opencode-go:deepseek-v4-pro   •  xhigh     ← synthesis + review
  Auto-trigger:     OFF
  Custom prompts:   — (none)
  Cost footer:      ON
  Project memory:   ON
  Offline mode:     ON
  Extensions:       inherit

  Sessions:         3 (7-day window, $0.0452 total)
  Project memory:   2 topics  /cdev recall
  Error log:        1 error  /cdev clear error to wipe

─────────────────────────────────────────────────────
```

`Current model` shows whatever `/model` is set to in your Pi session — the model that reads cdev's output and writes your code.

## TUI rendering

cdev registers custom renderers so the activity panel shows progress:

**During call:**

```
  cdev "explore auth deps"       full mode
  cdev-review                     review mode
  cdev-quick "trace imports"      quick mode
  cdev-recall "auth"              memory recall
```

**After completion (collapsed):**

```
  ✓ completed  flash→pro  $0.0040
  JWT in middleware.ts, 12 places found
  (expand)
```

**Expanded:**

```
  ✓ completed  flash→pro  $0.0040
    task: explore auth module deps
    Scout: flash (exit 0)
    Forge: pro (exit 0)

    EXPLORATION FINDINGS
    - JWT verification in middleware.ts
    ...
```
