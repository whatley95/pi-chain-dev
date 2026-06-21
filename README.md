# pi-chain-dev

Two-stage development fork for Pi coding agent — cheap model explores, powerful model synthesizes.

## Commands

| Command | What it does |
|---|---|
| `/cdev <task>` | Full two-stage: cheap model gathers evidence, powerful model writes structured report |
| `/cdev review` | Stage 2 only — reviews recent code changes for bugs, edge cases, and improvements |
| `/cdev auto on` | Auto-trigger mode — LLM proactively uses `cdev` for exploration tasks |
| `/cdev auto off` | Disable auto-trigger |
| `/cdev-model` | Interactive model picker — choose stage1/stage2 models from configured providers |
| `/cdev scan` | Instant template scan — detects stack from package.json, generates prompts (free, no LLM) |
| `/cdev scan deep` | LLM-powered scan — reads actual codebase, writes truly custom prompts (uses stage 1 → stage 2) |
| `/cdev prompts on` | Enable custom prompts (after scanning) |
| `/cdev prompts off` | Disable custom prompts — use generic ones instead |
| `/cdev history` | List recent cdev sessions (date, task, cost, status) |
| `/cdev history 3` | Show full detail for session #3 (models, tokens, cost) |

## How it works

```
  /cdev explore auth
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  STAGE 1 — cheap model (deepseek-v4-flash)   │
  │  Reads files, traces deps, gathers evidence  │
  │  Returns raw unfiltered findings             │
  └──────────────────┬───────────────────────────┘
                     │ raw findings
  ┌──────────────────▼───────────────────────────┐
  │  STAGE 2 — powerful model (deepseek-v4-pro)  │
  │  Synthesizes into structured report          │
  │  Result / Output / Evidence / Learnings      │
  └──────────────────┬───────────────────────────┘
                     │ report
                     ▼
              PARENT reads report, decides, codes
```

### Review mode (`/cdev review`)

```
  PARENT writes code
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  REVIEW — powerful model only (no stage 1)   │
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

Auto-discovered from `~/.pi/agent/extensions/pi-chain-dev/` — no install command needed if placed there.

Manual install:

```bash
pi install C:/dev/Project/pi-chain-fork   # or your local path
```

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
    "offline": true,
    "costFooter": true
  }
}
```

### Config keys

| Key | Type | Default | Description |
|---|---|---|---|
| `stage1.provider` | string | _required_ | Provider for exploration |
| `stage1.id` | string | _required_ | Model ID for exploration |
| `stage1.thinking` | `off` — `xhigh` | `minimal` | Thinking level for exploration |
| `stage2.provider` | string | _required_ | Provider for synthesis / review |
| `stage2.id` | string | _required_ | Model ID for synthesis / review |
| `stage2.thinking` | `off` — `xhigh` | `xhigh` | Thinking level for synthesis / review |
| `auto` | boolean | `false` | Auto-trigger mode (LLM proactively uses cdev) |
| `promptsEnabled` | boolean | `true` | Enable/disable custom prompts |
| `prompts.explore` | string | — | Custom Stage 1 exploration prompt |
| `prompts.synthesize` | string | — | Custom Stage 2 synthesis prompt |
| `prompts.review` | string | — | Custom review prompt |
| `offline` | boolean | `true` | Force `PI_OFFLINE=1` for child processes |
| `costFooter` | boolean | `true` | Show cdev cost in footer |

## Recommended model pairing

| Stage 1 (explore) | Stage 2 (synthesize / review) |
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
     → Stage 1: custom NestJS+Prisma prompt — only traces guards, modules, queries
     → Stage 2: custom synthesis prompt — ordered plan with breakage risks

LLM: reads report, decides approach, writes code

/cdev review                               # or LLM calls cdev({ review: true })
     → Stage 2 only: custom review prompt — checks NestJS-specific issues
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
- Stage 1 (cheap model): explores source files, maps patterns, gathers evidence
- Stage 2 (powerful model): synthesizes findings into truly custom prompts
- Accuracy: ~99% stack detection, ~85% prompt relevance

Edit `.pi/settings.json` anytime to tune prompts from either scan.

## Fallback to pi-fork

If `stage1`/`stage2` aren't configured, pi-chain-dev falls back to `pi-fork`'s effort profiles:
- `fast` → stage1, `deep` → stage2

## Project structure

```
pi-chain-dev/
├── index.ts          # Extension entry point — registers cdev tool + commands
├── runner.ts         # Two-stage fork runner + review mode
├── history.ts        # Session telemetry — save, list, purge (7 days)
├── scan.ts           # Project scanner — stack detection + prompt generator
├── types.ts          # Type definitions
├── config.ts         # Configuration loading
├── env.ts            # Child environment builder
├── runner-events.js  # JSON line parsing from child processes
└── runner-cli.js     # CLI arg inheritance
```
# pi-chain-dev
