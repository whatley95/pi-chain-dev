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
| `/cdev verify <task>` | Scout ×2 + forge — higher accuracy, ~2× stage 1 cost |
| `/cdev multi <n> <task>` | Split scout into n parallel sub-task scouts (1-3) using the project map; optional backup takes over failures |
| `/cdev multi <n> no-backup <task>` | Multi scouts without backup takeover (lower cost, risk of missing coverage) |
| `/cdev plan <task>` | Scout + planner forge — returns implementation roadmap with checklist |
| `/cdev yolo <task>` | Scout + forge, then auto review loops. Who edits is configurable (default: you) |
| `/cdev yolo on` | Enable YOLO review loops |
| `/cdev yolo off` | Disable YOLO mode (default) |
| `/cdev yolo manual` | Default — cdev reviews, you apply fixes between rounds |
| `/cdev yolo propose` | cdev reviews and writes a fix plan; you apply it |
| `/cdev yolo auto` | cdev reviews and edits files automatically between rounds (high trust) |
| `/cdev auto on` | Auto-trigger mode — LLM proactively uses `cdev` for exploration tasks |
| `/cdev auto off` | Disable auto-trigger |
| `/cdev auto-verify on` | Automatic scout ×2 for every `/cdev <task>` — ~2× stage 1 cost |
| `/cdev auto-verify off` | Scout ×1 unless `/cdev verify` is used explicitly (default) |
| `/cdev auto-compact on` | Auto-steer `/compact` when session snapshot nears model context limit (default) |
| `/cdev auto-compact off` | Only warn near model context limit |
| `/cdev-model` | Interactive model picker — choose scout/forge models from configured providers |
| `/cdev scan` | Instant template scan — detects stack from package.json, generates prompts (free, no LLM) |
| `/cdev scan deep` | LLM-powered scan — reads actual codebase, writes truly custom prompts (scout → forge) |
| `/cdev map` | Generate a project map for any stack (Flutter, Spring Boot, Python, Go, etc.) |
| `/cdev map refresh` | Regenerate project map via scout+forge |
| `/cdev map show` | View existing project map |
| `/cdev prompts on` | Enable custom prompts (after scanning) |
| `/cdev prompts off` | Disable custom prompts — use generic ones instead |
| `/cdev history` | List recent cdev sessions (date, task, cost, status, model chain) |
| `/cdev history 3` | Show full detail for session #3 (models, tokens, cost) |
| `/cdev replay 3` | Re-run session #3 as a new cdev task or review |
| `/cdev status` | Show full config overview — models, auto, prompts, memory, session size, costs, budget |
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
| `parallel` | integer | Split scout into N parallel sub-task scouts (1-3). Requires project map. |
| `parallelBackup` | boolean | Backup scout takes over failed parallel sub-tasks (default `true`) |
| `review` | boolean | Forge only (code review, skip scout) |
| `recall` | string | Retrieve past findings from project memory (e.g. `"auth"`) — $0, no fork |
| `recall` | `""` (empty) | List all known topics |
| `yolo` | boolean | Scout + forge, then auto review loops up to `pi-chain-dev.yolo.maxRounds`. Default mode leaves edits to the main agent. |
| `plan` | boolean | Scout + planner forge — returns risks, files, steps, checklist, and test commands |

Auto-trigger mode tells the LLM to use the tool proactively. The agent also receives prompt guidelines:
- Use `recall=<topic>` before re-exploring — costs $0, avoids duplicate work
- Use `recall=""` to list all known topics when starting in a project
- Use `plan:true` before a refactor to get a roadmap with checklist and verification commands
- Run `/cdev map` to generate a project map for any stack; scouts use it automatically for context
- Use `review:true` after significant code changes
- Use `quick:true` for quick file tracing
- Use `verify:true` for high-stakes exploration where accuracy matters more than speed or cost
- Use `research:true` for agent-driven investigation — the model reports findings but never edits code
- Use `parallel:<n>` to split a large exploration into n parallel scouts (requires map)
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

## Session health and cost budgets

`/cdev status` now shows live session metadata:

```
  Session size:     32 messages
  Session cost:     $0.0234 / $1.0000  🟡 23% of budget
  Today's cost:     $0.0234
```

- **Session size** is read-only. When it reaches ~40 messages, cdev warns: "Consider running /compact before the next cdev task." It never modifies the parent session automatically.
- **Context limit** defaults to 262,144 tokens. When a session snapshot is estimated to exceed ~95% of this limit, cdev warns. With `autoCompactOnLimit` (default `true`, toggled via `/cdev auto-compact on|off`), cdev steers `/compact` on the parent session instead of running the fork, so the main agent can compact and retry. When Pi reports a live context token count via `ctx.getContextUsage()`, cdev uses that exact number; otherwise it falls back to the configurable `tokenEstimationCharsPerToken` heuristic.
- **Cost budgets** are configured with `maxSessionCost` (and `maxForkCost`) in settings. Alerts fire at 80% (warn) and 95% (critical) of the session budget. Budget checks also block forks that would exceed the limit.
- **Cost tracking is cdev-only.** Session cost, today's cost, and budgets measure only the tokens consumed by cdev child forks (scout, forge, review, yolo). They do **not** include the main/parent Pi agent's own usage.

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

If stage 1 output is invalid or empty, cdev retries the scout stage once automatically. If findings are sparse (fewer than 3) or mostly low-confidence, cdev runs a second exploration pass automatically and merges the results (unless verify mode already ran two scouts). If it still fails, cdev falls back to passing the raw text to forge rather than failing completely.

### Auto-verify (`/cdev auto-verify`)

By default, every `/cdev <task>` runs scout once (`autoVerify: false`). You can toggle this:

- `/cdev auto-verify on` — scout ×2 automatically (~2× stage 1 cost)
- `/cdev auto-verify off` — scout ×1 unless you use `/cdev verify <task>` (default)

The setting is stored in `~/.pi/agent/settings.json` under `pi-chain-dev.autoVerify`.

You can also configure a second scout model (`pi-chain-dev.stage1b`) so the two runs use different models for broader coverage. If unset, both runs use `stage1`. Use `/cdev-model` → "Scout B (verify)" to set it.

### Auto-compact (`/cdev auto-compact`)

By default, when a session snapshot is estimated to exceed ~95% of `modelContextLimit`, cdev refuses to run and steers `/compact` on the parent session. This lets the main agent compact the conversation before retrying, avoiding model context limit errors.

- `/cdev auto-compact on` — auto-steer `/compact` near limit (default)
- `/cdev auto-compact off` — only warn near limit

The setting is stored in `~/.pi/agent/settings.json` under `pi-chain-dev.autoCompactOnLimit`. You can also adjust `pi-chain-dev.modelContextLimit` to match your model's actual context window.

### Accuracy safeguards

Every forge report includes a **grounding score** (0–100%) and a list of **ungrounded claims**. Forge is instructed to self-check each claim against the stage 1 evidence and flag anything that isn't directly supported.

The report shows:

```
## Grounding ✅ 100%
All claims are grounded in the exploration evidence.
```

or

```
## Grounding ⚠️ 50%
- The auth module uses OAuth2 (no evidence in scout findings)
- Rate limit is 100 req/min (only config.js was checked, not the limit value)
```

If grounding is low or findings were sparse/low-confidence, cdev automatically re-explored before forge. You can still re-run with `/cdev verify <task>` or `/cdev quick <topic>` for deeper confirmation.

### Verify mode (`/cdev verify <task>`)

```
  Parent: "I need high-confidence exploration before a big refactor"
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT A — cheap model                       │
  │  Returns structured findings                 │
  └──────────────────┬───────────────────────────┘
                     │
  ┌──────────────────┼───────────────────────────┐
  │  SCOUT B — same model                        │
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

If one scout run produces invalid findings, cdev uses the valid run. If both are invalid, cdev falls back to the raw text from the first run. The two runs use the same model configuration unless you set `stage1b`; their independence (different random samples, and optionally different models) gives broader coverage without relying on unsupported CLI flags.

### Multi mode (`/cdev multi <n> <task>`)

Split the exploration into n parallel scouts (1-3). Each scout focuses on a different slice of the project based on the project map (modules, boundaries, or source roots), so large tasks finish faster wall-clock.

```
  /cdev multi 3 find all API endpoints
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT A — focus on auth module              │
  ├──────────────────────────────────────────────┤
  │  SCOUT B — focus on payment module           │
  ├──────────────────────────────────────────────┤
  │  SCOUT C — focus on orders module            │
  └──────────────────┬───────────────────────────┘
                     │ merge unique / deduplicate
                     ▼
  ┌──────────────────────────────────────────────┐
  │  BACKUP (optional) — takes over any failed   │
  │  scout's slice so coverage stays high        │
  └──────────────────┬───────────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────────┐
  │  FORGE — powerful model                      │
  │  Synthesizes merged findings into report     │
  └──────────────────┬───────────────────────────┘
                     │ report
                     ▼
              PARENT reads report, decides, codes
```

Requirements:
- Run `/cdev map` first so there are modules/boundaries to split by.
- Configure different models via `/cdev-model` → Scout B / Scout C / Backup if desired.
- Backup is on by default; add `no-backup` to save cost at the risk of missing a failed slice.

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

If the file or diff is too large to fit on the command line, cdev automatically offloads the review prompt into the session snapshot file and passes only a short continuation prompt to the child Pi process. Very large files are also truncated with a clear notice so the review stays within model context limits.

### Plan mode (`/cdev plan <task>`)

Same scout → forge pipeline as full mode, but the forge prompt asks for an implementation plan instead of a research report.

```
  /cdev plan refactor auth to middleware
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT — cheap model                         │
  │  Gathers evidence: files, deps, edge cases   │
  └──────────────────┬───────────────────────────┘
                     │ validated findings
   ┌──────────────────▼───────────────────────────┐
   │  FORGE — powerful model (planner prompt)     │
   │  Returns PlanReport:                         │
   │  • risks[]                                   │
   │  • files { read[], toModify[], toCreate[] }  │
   │  • steps[] with verification                 │
   │  • checklist[] — ordered, actionable tasks   │
   │  • testCommands[]                            │
   └──────────────────┬───────────────────────────┘
                      │ plan
                      ▼
               PARENT implements checklist
```

Use this before a refactor when you want a concrete roadmap. The checklist is designed to be checked off one item at a time.

### YOLO mode (`/cdev yolo <task>`)

YOLO runs scout + forge once, then loops review up to `maxRounds` times. It stops early when the review returns `pass` (if `stopOnPass` is true).

The key difference is **who applies fixes between reviews**:

| Mode | Who edits | Command |
|---|---|---|
| `manual` (default) | **You / main agent** | `/cdev yolo manual` |
| `propose` | cdev writes a fix plan; you apply it | `/cdev yolo propose` |
| `auto` | cdev edits files directly | `/cdev yolo auto` |

```
  Parent: "Implement this feature and keep reviewing until it passes"
       │
       ▼
  ┌──────────────────────────────────────────────┐
  │  SCOUT + FORGE — initial plan/report         │
  └──────────────────┬───────────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────────┐
  │  YOU implement (manual/propose)              │
  │  OR cdev auto-fixes (auto)                   │
  └──────────────────┬───────────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────────┐
  │  REVIEW — check the current state            │
  │  Verdict: pass / needs-work / blocked        │
  └──────────────────┬───────────────────────────┘
                     │
          ┌───────────┴───────────┐
          │ pass                  │ needs-work / blocked
          ▼                       ▼
        DONE                 apply fixes
                                 │
                                 ▼
                        repeat up to maxRounds
```

Configuration (default safe):

```json
{
  "pi-chain-dev": {
    "yolo": {
      "enabled": false,
      "maxRounds": 3,
      "stopOnPass": true,
      "autoApply": "manual"
    }
  }
}
```

| `autoApply` | Behaviour |
|---|---|
| `manual` | cdev reviews; you apply fixes. Default and safest. |
| `propose` | cdev reviews and outputs a concrete fix plan; you apply it. |
| `auto` | cdev reviews and edits files directly between rounds. Use with caution. |

`maxRounds` is clamped to 7. Each round costs roughly one review fork (plus a fix fork in `propose`/`auto` mode), so YOLO can be very expensive. Enable only when you want the agent to iterate unsupervised.

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

### Build date hook

The `Version` line in `/cdev status` includes a build timestamp that is auto-updated on every commit. To enable it, install the pre-commit hook once per clone:

```bash
npm run setup-hook
```

The installer refuses to overwrite an existing pre-commit hook unless you pass `--force`. If you already have a pre-commit hook, chain or copy `scripts/update-build-date.cjs` manually.

`npm run build` also updates the build date before compiling, so a fresh build always shows the current timestamp even without the hook.

The hook rewrites `src/build-date.ts` with the current UTC timestamp and stages it before each commit.

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

Contains: sessions (`.pi/cdev/sessions/`), reports (`.pi/cdev/reports/`), maps (`.pi/cdev/map.yaml`), memory (`.pi/cdev/memory.json`), error logs (`.pi/cdev/errors.jsonl`).

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
    "stage1b": {
      "provider": "opencode-go",
      "id": "deepseek-v4-flash",
      "thinking": "low"
    },
    "stage1c": {
      "provider": "opencode-go",
      "id": "deepseek-v4-flash",
      "thinking": "low"
    },
    "stage1Backup": {
      "provider": "opencode-go",
      "id": "deepseek-v4-flash",
      "thinking": "low"
    },
    "stage2": {
      "provider": "opencode-go",
      "id": "deepseek-v4-pro",
      "thinking": "xhigh"
    },
    "auto": false,
    "autoVerify": false,
    "parallel": 1,
    "parallelBackup": true,
    "promptsEnabled": true,
    "memory": true,
    "offline": true,
    "modelContextLimit": 262144,
    "autoCompactOnLimit": true,
    "tokenEstimationCharsPerToken": 4,
    "costFooter": true,
    "yolo": {
      "enabled": false,
      "maxRounds": 3,
      "stopOnPass": true,
      "autoApply": "manual"
    }
  }
}
```

### Config keys

| Key | Type | Default | Description |
|---|---|---|---|
| `stage1.provider` | string | _required_ | Provider for scout (exploration) |
| `stage1.id` | string | _required_ | Model ID for scout |
| `stage1.thinking` | `off` — `xhigh` | `minimal` | Thinking level for scout |
| `stage1b.provider` | string | — | Optional second scout model for verify mode |
| `stage1b.id` | string | — | Model ID for second scout |
| `stage1b.thinking` | `off` — `xhigh` | `minimal` | Thinking level for second scout |
| `stage1c.provider` | string | — | Optional third scout model for multi mode |
| `stage1c.id` | string | — | Model ID for third scout |
| `stage1c.thinking` | `off` — `xhigh` | `minimal` | Thinking level for third scout |
| `stage1Backup.provider` | string | — | Optional backup scout that takes over failed multi slices |
| `stage1Backup.id` | string | — | Model ID for backup scout |
| `stage1Backup.thinking` | `off` — `xhigh` | `minimal` | Thinking level for backup scout |
| `stage2.provider` | string | _required_ | Provider for forge (synthesis/review) |
| `stage2.id` | string | _required_ | Model ID for forge |
| `stage2.thinking` | `off` — `xhigh` | `xhigh` | Thinking level for forge |
| `auto` | boolean | `false` | Auto-trigger mode (LLM proactively uses cdev) |
| `autoVerify` | boolean | `false` | Automatic scout ×2 for higher accuracy |
| `parallel` | integer | `1` | Default number of parallel scouts for `cdev` tool calls |
| `parallelBackup` | boolean | `false` | Backup scout takes over failed parallel sub-tasks |
| `maxConcurrentStages` | integer | `3` | Max child Pi processes cdev spawns simultaneously |
| `scoutTimeoutMs` | number | `600000` | Per-scout stage timeout in milliseconds (min 30s, max 1h) |
| `forgeTimeoutMs` | number | `180000` | Forge/plan/review stage timeout in milliseconds (min 30s, max 1h) |
| `modelContextLimit` | number | `262144` | Model context-window limit in tokens (used for snapshot sizing and warnings) |
| `autoCompactOnLimit` | boolean | `true` | Auto-steer `/compact` when session snapshot exceeds 95% of `modelContextLimit` |
| `tokenEstimationCharsPerToken` | number | `4` | Characters per token used to estimate snapshot size. Increase (e.g. `8`–`12`) if cdev estimates much higher than Pi's status bar |
| `promptsEnabled` | boolean | `true` | Enable/disable custom prompts |
| `prompts.explore` | string | — | Custom scout exploration prompt |
| `prompts.synthesize` | string | — | Custom forge synthesis prompt |
| `prompts.review` | string | — | Custom review prompt |
| `memory` | boolean | `true` | Enable/disable project-level memory |
| `yolo.enabled` | boolean | `false` | Enable `/cdev yolo` command |
| `yolo.maxRounds` | number | `3` | Max review-fix rounds (clamped to 7) |
| `yolo.stopOnPass` | boolean | `true` | Stop looping when review returns pass |
| `yolo.autoApply` | `"manual"` \| `"propose"` \| `"auto"` | `"manual"` | Who applies fixes each round. `manual` = main agent, `propose` = cdev plan, `auto` = cdev edits files |
| `yolo.reviewProfile` | object | — | Optional model profile for yolo review rounds |
| `yolo.fixProfile` | object | — | Optional model profile for yolo fix rounds |
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

LLM: wants a roadmap → calls cdev({ task: "plan auth middleware refactor", plan: true })
     → Scout + planner forge: checklist, risks, test commands

/cdev review                               # or LLM calls cdev({ review: true })
     → Forge only: custom review prompt — checks NestJS-specific issues
     → Pass / needs-work / blocked, specific issues

LLM / you: fix issues, re-review if needed
```

## Project map

### `/cdev map` — Stack-agnostic project overview

`/cdev map` generates `.pi/cdev/map.yaml`, a structured project overview that any scout can load before exploring. It works for any project type: Flutter, Spring Boot, Python, Go, Rust, Ruby, PHP, etc.

```yaml
project:
  name: my-app
  type: flutter-mobile
  language: Dart
  languages: [Dart]
  entryPoints: [lib/main.dart]
stack:
  framework: [Flutter]
  backend: []
  frontend: []
  mobile: [Flutter]
  orm: []
  auth: []
  testing: [flutter_test]
  validation: []
  styling: []
  build: []
  stateManagement: []
  packageManager: [pub]
  db: []
  monorepo: []
structure:
  rootDirs: [lib, test, android, ios]
  sourceRoots: [lib]
  testRoots: [test]
  configFiles: [pubspec.yaml, analysis_options.yaml]
  importantFiles: [lib/main.dart]
conventions:
  folderStructure: Feature-first or layer-first under lib/
  naming: snake_case files, PascalCase widgets/classes
  stateManagement: Check for Riverpod, Bloc, Provider, or GetX
config:
  envFiles: []
  buildCommands: [flutter build apk]
  testCommands: [flutter test]
  runCommands: [flutter run]
  lintCommands: [flutter analyze]
architecture:
  patterns: [Widget tree, Feature modules]
  layers:
    presentation: [lib/**/widgets/, lib/**/screens/]
    domain: [lib/**/models/]
    data: [lib/**/repositories/]
notes:
  - This map is a starting point. Run `/cdev map refresh` after major structural changes.
  - Scout will use this map when available to focus exploration.
generatedAt: "2026-06-23T16:00:00.000Z"
generatedBy: "cdev scout+forge map generator"
```

Commands:

| Command | What it does |
|---|---|
| `/cdev map` | Generate map from template detection |
| `/cdev map refresh` | Regenerate via scout+forge (reads actual source files) |
| `/cdev map show` | Display existing map |

When a map exists, every scout prompt automatically includes a `<project_map>` summary so the model knows the stack, entry points, conventions, and architecture before reading files.

## Stack detection

### `/cdev scan` — Template (free, instant)

Reads project files (`package.json`, `pubspec.yaml`, `pom.xml`, `build.gradle`, `go.mod`, etc.) and directory structure to detect stack from pre-coded patterns:

- **Mobile**: Flutter
- **Backend (Java/Kotlin)**: Spring Boot
- **Backend (Node)**: NestJS, Express, Fastify, Koa, Hono
- **Frontend**: Next.js, React, Vue, Angular, SvelteKit, Nuxt, Remix, Astro
- **ORM**: Prisma, TypeORM, Drizzle, Mongoose, Sequelize, Knex, MikroORM
- **Auth**: JWT, Passport, NextAuth, Clerk, Lucia
- **Testing**: Jest, Vitest, Mocha, Cypress, Playwright
- **Validation**: Zod, class-validator, Joi, Yup, Valibot
- **Styling**: Tailwind, styled-components, Emotion, Sass, Shadcn/ui, Radix, Mantine, Chakra, Ant Design
- **Build**: Vite, Webpack, tsup, esbuild, Rollup
- **State**: Zustand, Redux, Jotai, MobX, Pinia, TanStack Query
- **DB**: PostgreSQL, MySQL, MongoDB, Redis, SQLite, H2 (from docker-compose.yml, Prisma schema, Gradle deps)
- **Monorepo**: Turborepo, Nx, Lerna
- **Languages**: TypeScript, JavaScript, Dart, Java, Kotlin, Python, Go, Rust, Ruby, PHP, Swift, C#, C++, C

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
│   │   ├── cdev.ts           # /cdev command dispatcher + lifecycle handlers
│   │   ├── cdev-model.ts     # /cdev-model interactive model picker
│   │   ├── cdev-scan.ts      # /cdev scan and /cdev scan deep implementation
│   │   └── cdev-memory.ts    # /cdev recall, view, memory *, memory refresh/on/off
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
