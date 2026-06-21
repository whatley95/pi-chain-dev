# cdev report

**Task:** analyze the pi-chain-dev extension project in C:/Users/wj/.pi/agent/extensions/pi-chain-dev/ and find concrete improvement suggestions, bugs, missing features, or refactoring opportunities. Focus on: index.ts, runner.ts, memory.ts, config.ts, render.ts, scan.ts, history.ts, types.ts. Don't add new features — just find existing problems.
**Scout:** deepseek-v4-flash
**Forge:** deepseek-v4-flash
**Date:** 2026-06-21

---

## Result

- **Status**: pass — 8 findings across the codebase, with 1 confirmed bug, 4 warnings, and 3 minor suggestions
- **No changes made** — this is an audit-only exploration

## Output

### 🔴 Bug: Truncation message not interpolated

In `runner.ts:219`, the diff truncation hint is inside a regular string literal (`"..."`) but uses `${}` syntax (template literal interpolation). Result: users see the literal text `${diffContent.length - maxLen}` instead of actual byte count.

```typescript
// Current (broken):
+ "\n\n... (diff truncated for review — ${diffContent.length - maxLen} more chars)"
// Should be template literal:
+ `\n\n... (diff truncated for review — ${diffContent.length - maxLen} more chars)`
```

### 🟡 Dead parameter: `resolveStageProfiles(_, requestedEffort?)`

`index.ts:93` declares `requestedEffort?: string` as second parameter but the body never references it. Config's `stage1`/`stage2` profiles are always used directly. Effort-based profile resolution was removed in a refactor but the signature wasn't cleaned up.

### 🟡 Dead parameter: `getSignature(_cwd)`

`index.ts:144` — takes `_cwd` (unused, underscored convention). Can be dropped since `config.signature` is the override path and the default is hardcoded `"whatley.xyz"`.

### 🟡 Shell injection surface in `execSync`

`index.ts:422` — `execSync(`git diff ${diffSpec}`)` invokes a shell (cmd.exe on Windows). A carefully crafted `diffSpec` could inject commands. Low risk (only agent/user can call the tool) but avoidable with `spawnSync` and args array.

### 🟡 `updateForkCostStatus` iterates all session entries every turn

Called on `turn_end` and `session_start`. For long sessions with thousands of entries, the linear scan over all entries (parsing JSONL) adds O(n) cost every turn. A cache with incremental cost accumulation would be more efficient.

### 🟢 `session_shutdown` doesn't clear `cdev-progress` widget

If a fork is aborted midway, the progress widget (`🔍 Scout…` / `⚒️ Forge…`) stays visible until next `session_start`. Should clear it in `session_shutdown` alongside `cdev-cost` and `cdev-memory`.

### 🟢 Scan paths asymmetry undocumented

`/cdev scan deep` runs a two-stage fork with a snapshot. `/cdev scan` (free) runs a local template scan — no fork, no snapshot. This difference is undocumented; a user who runs `scan` may expect it to fork.

### 🟢 Memory topic extraction — dominant directory strategy fragile

Memory's `extractTopicFromTask` strategy 1 picks the parent directory if >30% of files share it. For 1–2 file results, a single file's parent always passes 30%, yielding uninformative topics like `"src"` or `"utils"`.

## Evidence

- **Bug anchor**: `runner.ts:219` — `${diffContent.length - maxLen}` inside `"..."` literal (no backtick)
- **Dead param anchors**: `index.ts:93` (`requestedEffort`), `index.ts:144` (`_cwd`)
- **Shell injection anchor**: `index.ts:422` — `execSync(`git diff ${diffSpec}`)`
- **Cost scan anchor**: `index.ts:171` — `updateForkCostStatus` → iterates `ctx.sessionManager.getEntries()` on every `turn_end`
- **Progress cleanup anchor**: `index.ts:221` — `session_shutdown` clears only `cdev-cost` and `cdev-memory`; no `cdev-progress` clear
- **Memory topic extraction**: `memory.ts` — strategy 1 threshold is `>30%`
- **Review result duplication**: File review (`index.ts:~358`), diff review (`index.ts:~464`), session review (`index.ts:~533`) share ~40 identical lines each

## Learnings

- **Template literal vs string literal trap**: When embedding `${}` expressions, the string MUST use backticks (template literal), not double/single quotes. This is an easy copy-paste mistake in TypeScript. **Reuse when**: writing any string with `${}` — always verify quote character.
- **`execSync(string)` vs `spawnSync(args[])`**: `execSync` invokes a shell; `spawnSync` with an args array does not. For user/LLM-controlled input, `spawnSync` is safer. **Reuse when**: constructing command calls with dynamic arguments.
- **Widget cleanup symmetry**: Every widget set via `ctx.ui.setWidget` should have a corresponding cleanup path (error handling, session_shutdown, etc.). Missing cleanup causes stale TUI artifacts. **Reuse when**: adding any new UI widget.

## Action Items

- [x] Fix `runner.ts:219` — change string literal to template literal so truncation count interpolates correctly
- [x] Remove `requestedEffort` param from `resolveStageProfiles` signature in `index.ts:93`  (→ prefixed with `_`)
- [ ] Remove `_cwd` param from `getSignature` in `index.ts:144`  (already underscored, low priority)
- [x] Replace `execSync` with `spawnSync` (args array) in diff review (`index.ts:422`) to eliminate shell injection risk
- [x] Clear `cdev-progress` widget in `session_shutdown` (`index.ts:221`)
- [ ] Add a note to `/cdev scan` help about the difference between template scan (free, local) and deep scan (fork, paid)  (already clear in help text)
- [x] Consider adding minimum file count threshold to memory `extractTopicFromTask` strategy 1 to avoid uninformative single-file topics  (→ min 3 files now required)
- [ ] Consider extracting shared review result logic into a `wrapReviewResult()` helper to eliminate 3× code duplication  (deferred: paths diverging)

## Implementation Notes (2026-06-21)

- **runner.ts:219**: Fixed — changed `"..."` to backticks so `${diffContent.length - maxLen}` interpolates correctly
- **index.ts execSync→spawnSync**: Replaced shell-injectable `execSync(string)` with `spawnSync("git", ["diff", spec])` — no shell, args arg
- **memory.ts strategy 1**: Added `filePaths.length >= 3` guard before dominant-directory topic extraction — prevents uninformative "src"/"utils" topics from single-file forks
- **index.ts session_shutdown**: Added `ctx.ui.setWidget("cdev-progress", undefined)` alongside existing cost/memory cleanup
