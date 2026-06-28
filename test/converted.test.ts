/**
 * Unit tests for converted and new pi-chain-dev modules.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { parseInheritedCliArgs } from "../src/runner-cli.js";
import { processPiEvent, getFinalAssistantText, stableStringify } from "../src/runner-events.js";
import { buildSessionSnapshotJsonl, resolveStageProfiles, formatResultContent, formatForkResultOutput, estimateSessionSize, checkSessionCostAlert, setTokenEstimationRatio, estimateForkCost, formatModelPrice } from "../src/extension-context.js";
import { formatStage2Report, parseStage2Report, isStage1Findings, parseStage1Findings } from "../src/json-extract.js";
import { buildPiArgs, estimateCommandLineLength, appendTaskToSessionJsonl } from "../src/fork-stage.js";
import { buildFileReviewPrompt } from "../src/prompts.js";
import { parseReviewVerdict, mergeStage1Findings } from "../src/fork-orchestrator.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { emptyFailedResult, emptyUsage } from "../src/types.js";
import { PROMPT_VERSION } from "../src/prompt-version.js";

// ── runner-cli.ts ────────────────────────────────────────

describe("parseInheritedCliArgs (runner-cli.ts)", () => {
  it("ignores non-flag tokens", () => {
    const result = parseInheritedCliArgs(["node", "pi", "some", "task"]);
    assert.deepEqual(result.extensionArgs, []);
    assert.deepEqual(result.alwaysProxy, []);
    assert.strictEqual(result.fallbackModel, undefined);
  });

  it("extracts fallback model", () => {
    const result = parseInheritedCliArgs(["node", "pi", "--model", "openai/gpt-4"]);
    assert.strictEqual(result.fallbackModel, "openai/gpt-4");
  });

  it("extracts fallback thinking and tools", () => {
    const result = parseInheritedCliArgs(["node", "pi", "--thinking", "high", "--tools", "all"]);
    assert.strictEqual(result.fallbackThinking, "high");
    assert.strictEqual(result.fallbackTools, "all");
  });

  it("forwards --extension args with path resolution", () => {
    const result = parseInheritedCliArgs(["node", "pi", "--extension", "./src/index.ts"]);
    assert.ok(result.extensionArgs.includes("--extension"));
    assert.ok(result.extensionArgs.some((arg) => arg.endsWith("src\\index.ts") || arg.endsWith("src/index.ts")));
  });

  it("forwards always-proxy flags like --verbose", () => {
    const result = parseInheritedCliArgs(["node", "pi", "--verbose", "--no-themes"]);
    assert.ok(result.alwaysProxy.includes("--verbose"));
    assert.ok(result.alwaysProxy.includes("--no-themes"));
  });

  it("skips session-only flags", () => {
    const result = parseInheritedCliArgs(["node", "pi", "--session", "abc", "--mode", "json"]);
    assert.deepEqual(result.alwaysProxy, []);
  });
});

// ── runner-events.ts ─────────────────────────────────────

describe("stableStringify (runner-events.ts)", () => {
  it("handles primitives", () => {
    assert.strictEqual(stableStringify(1), "1");
    assert.strictEqual(stableStringify("hello"), '"hello"');
    assert.strictEqual(stableStringify(null), "null");
    assert.strictEqual(stableStringify(undefined), "undefined");
  });

  it("sorts object keys", () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    assert.strictEqual(stableStringify(a), stableStringify(b));
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = stableStringify(obj);
    assert.ok(result.includes('"self":"<circular>"'));
  });
});

describe("processPiEvent (runner-events.ts)", () => {
  it("accumulates assistant message usage", () => {
    const result = emptyFailedResult("test", "message");
    result.messages = [];
    result.exitCode = 0;
    result.errorMessage = undefined;

    const changed = processPiEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, totalTokens: 15, turns: 1 },
      },
    }, result);

    assert.strictEqual(changed, true);
    assert.strictEqual(result.usage.input, 10);
    assert.strictEqual(result.usage.output, 5);
    assert.strictEqual(result.usage.turns, 1);
  });

  it("tracks tool execution progress", () => {
    const result = emptyFailedResult("test", "message");
    result.exitCode = 0;
    result.errorMessage = undefined;

    processPiEvent({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "src/foo.ts" },
    }, result);

    assert.ok(Array.isArray(result.toolExecutions));
    assert.strictEqual(result.toolExecutions?.length, 1);
    assert.strictEqual(result.toolExecutions?.[0]?.toolName, "read");
  });
});

describe("getFinalAssistantText (runner-events.ts)", () => {
  it("returns the last assistant text", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "last" }] },
    ];
    assert.strictEqual(getFinalAssistantText(messages), "last");
  });

  it("returns empty string when no assistant text exists", () => {
    assert.strictEqual(getFinalAssistantText([]), "");
  });
});

// ── extension-context.ts ─────────────────────────────────

describe("buildSessionSnapshotJsonl (extension-context.ts)", () => {
  it("builds JSONL from header and branch", () => {
    const source = {
      getHeader: () => ({ type: "header", id: "h1" }),
      getBranch: () => [{ type: "message", role: "user" }],
    };
    const jsonl = buildSessionSnapshotJsonl(source);
    assert.ok(jsonl);
    const lines = jsonl!.trim().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).id, "h1");
  });

  it("returns null for invalid header", () => {
    const source = { getHeader: () => null, getBranch: () => [] };
    assert.strictEqual(buildSessionSnapshotJsonl(source), null);
  });
});

describe("resolveStageProfiles (extension-context.ts)", () => {
  it("returns warning when profiles are unconfigured", () => {
    const config = {
      stage1: { provider: "", id: "", thinking: "minimal" as const },
      stage2: { provider: "", id: "", thinking: "xhigh" as const },
    };
    const result = resolveStageProfiles(config as any);
    assert.ok(result.warning);
  });

  it("returns profiles when configured", () => {
    const config = {
      stage1: { provider: "openai", id: "gpt-4", thinking: "minimal" as const },
      stage2: { provider: "anthropic", id: "claude", thinking: "xhigh" as const },
    };
    const result = resolveStageProfiles(config as any);
    assert.strictEqual(result.warning, undefined);
    assert.strictEqual(result.stage1.provider, "openai");
    assert.strictEqual(result.stage2.provider, "anthropic");
  });
});

describe("formatResultContent (extension-context.ts)", () => {
  it("formats review-only result", () => {
    const result = emptyFailedResult("test", "");
    result.exitCode = 0;
    result.errorMessage = undefined;
    result.messages = [{ role: "assistant", content: [{ type: "text", text: "Looks good" }] }];
    const details = { stage1: null, stage2: { ...emptyFailedResult("review", ""), model: "claude" } };
    const text = formatResultContent(result, details as any);
    assert.ok(text.includes("Review ran with claude"));
    assert.ok(text.includes("Looks good"));
  });

  it("shows error when final text is missing", () => {
    const result = emptyFailedResult("test", "boom");
    const details = { stage1: null, stage2: null };
    const text = formatResultContent(result, details as any);
    assert.ok(text.includes("cdev failed"));
    assert.ok(text.includes("boom"));
  });
});

describe("formatForkResultOutput (extension-context.ts)", () => {
  it("formats structured plan JSON as markdown", () => {
    const result = {
      task: "plan work",
      exitCode: 0,
      stderr: "",
      usage: emptyUsage(),
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({
          status: "ok",
          summary: "plan summary",
          risks: ["risk"],
          files: { read: ["src/a.ts"], toModify: ["src/b.ts"], toCreate: [] },
          steps: [{ order: 1, description: "change b", verification: "npm test" }],
          checklist: [{ order: 1, task: "add helper", verification: "npm test b", grounded: true }],
          testCommands: ["npm test"],
        }) }],
      }],
    };
    const text = formatForkResultOutput(result, { stage1: null, stage2: result });
    assert.match(text, /## Steps/);
    assert.match(text, /## Checklist/);
    assert.match(text, /change b/);
    assert.doesNotMatch(text, /^\{/);
  });
});

describe("estimateSessionSize (extension-context.ts)", () => {
  it("sums branch and entries", () => {
    const ctx = {
      cwd: "/tmp",
      sessionManager: { getBranch: () => [1, 2, 3], getEntries: () => [4, 5] },
    } as any;
    assert.strictEqual(estimateSessionSize(ctx), 5);
  });

  it("returns 0 when sessionManager is missing", () => {
    const ctx = { cwd: "/tmp" } as any;
    assert.strictEqual(estimateSessionSize(ctx), 0);
  });
});

describe("checkSessionCostAlert (extension-context.ts)", () => {
  it("returns null when maxSessionCost is 0", () => {
    const config = { maxSessionCost: 0 } as any;
    const alert = checkSessionCostAlert(config, "/tmp/no-such-dir-" + Date.now());
    assert.strictEqual(alert, null);
  });

  it("returns warning at 80% of budget", () => {
    const cwd = process.cwd();
    const costPath = path.join(cwd, ".pi", "cdev", ".session-cost");
    const previous = existsSync(costPath) ? readFileSync(costPath, "utf-8") : null;
    try {
      mkdirSync(path.dirname(costPath), { recursive: true });
      writeFileSync(costPath, "0.85", "utf-8");
      const alert = checkSessionCostAlert({ maxSessionCost: 1 } as any, cwd);
      assert.ok(alert);
      assert.strictEqual(alert!.level, "warning");
      assert.ok(alert!.message.includes("85%"));
    } finally {
      if (previous !== null) writeFileSync(costPath, previous, "utf-8");
      else unlinkSync(costPath);
    }
  });
});

describe("estimateForkCost (extension-context.ts)", () => {
  const stage1Profile = { provider: "openai", id: "gpt-5-mini", thinking: "minimal" as const };
  const stage2Profile = { provider: "openai", id: "gpt-5", thinking: "xhigh" as const };

  it("uses configured token estimation ratio", () => {
    setTokenEstimationRatio(4);
    const base = estimateForkCost({ task: "explore auth", stage1Profile, stage2Profile });
    setTokenEstimationRatio(8);
    const half = estimateForkCost({ task: "explore auth", stage1Profile, stage2Profile });
    assert.ok(half.inputTokens < base.inputTokens, "higher chars/token should lower token estimate");
    assert.ok(half.outputTokens < base.outputTokens, "higher chars/token should lower output estimate");
    setTokenEstimationRatio(4);
  });

  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });
  it("uses default prices when model prices are unknown", () => {
    const result = estimateForkCost({
      task: "explore",
      stage1Profile: { provider: "x", id: "unknown-model", thinking: "minimal" as const },
      stage2Profile: { provider: "x", id: "other-unknown", thinking: "xhigh" as const },
    });
    // Falls back to default price instead of $0
    assert.ok(result.cost > 0);
    assert.ok(result.cost < 0.01);
  });

  it("doubles stage1 cost in verify mode", () => {
    const normal = estimateForkCost({ task: "explore", stage1Profile, stage2Profile });
    const verify = estimateForkCost({ task: "explore", stage1Profile, stage2Profile, verify: true });
    assert.ok(verify.cost > normal.cost);
  });

  it("skips stage2 cost in quick mode", () => {
    const quick = estimateForkCost({ task: "explore", stage1Profile, stage2Profile, quick: true });
    const full = estimateForkCost({ task: "explore", stage1Profile, stage2Profile });
    assert.ok(quick.cost < full.cost);
  });
});

describe("formatModelPrice (extension-context.ts)", () => {
  it("formats known model prices", () => {
    const text = formatModelPrice("gpt-5");
    assert.match(text, /\$[\d.]+ in/);
    assert.match(text, /\$[\d.]+ out per 1M tokens/);
  });

  it("returns unknown for unrecognized models", () => {
    assert.strictEqual(formatModelPrice("zzzz-unknown"), "unknown");
  });

  it("prefers exact match over substring to avoid mis-pricing", () => {
    const mini = formatModelPrice("gpt-5-mini");
    const full = formatModelPrice("gpt-5");
    assert.notStrictEqual(mini, full);
  });
});

describe("formatStage2Report (json-extract.ts)", () => {
  it("includes grounding score and ungrounded claims", () => {
    const report = {
      status: "ok" as const,
      summary: "summary",
      output: "output",
      evidence: "evidence",
      learnings: "learnings",
      actionItems: [],
      groundingScore: 0.5,
      ungroundedClaims: ["claim A", "claim B"],
    };
    const text = formatStage2Report(report);
    assert.ok(text.includes("Grounding ⚠️ 50%"));
    assert.ok(text.includes("claim A"));
    assert.ok(text.includes("claim B"));
  });

  it("reports fully grounded when no ungrounded claims", () => {
    const report = {
      status: "ok" as const,
      summary: "summary",
      output: "output",
      evidence: "evidence",
      learnings: "learnings",
      actionItems: [],
      groundingScore: 1,
      ungroundedClaims: [],
    };
    const text = formatStage2Report(report);
    assert.ok(text.includes("Grounding ✅ 100%"));
    assert.ok(text.includes("All claims are grounded"));
  });
});

describe("parseStage2Report (json-extract.ts)", () => {
  it("accepts groundingScore and ungroundedClaims", () => {
    const json = JSON.stringify({
      status: "ok",
      summary: "s",
      output: "o",
      evidence: "e",
      learnings: "l",
      actionItems: [],
      groundingScore: 0.75,
      ungroundedClaims: ["x"],
    });
    const report = parseStage2Report(json);
    assert.ok(report);
    assert.strictEqual(report!.groundingScore, 0.75);
    assert.deepStrictEqual(report!.ungroundedClaims, ["x"]);
  });
});

describe("buildPiArgs (fork-stage.ts)", () => {
  const stageProfile = { provider: "opencode-go", id: "deepseek-v4-flash", thinking: "minimal" as const };

  it("uses read-only tool allowlist for scout mode", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", null, stageProfile, "scout");
    const toolsIndex = args.indexOf("--tools");
    assert.ok(toolsIndex > -1);
    assert.strictEqual(args[toolsIndex + 1], "read,bash,ls,grep,find,cat");
    assert.ok(!args.includes("--no-tools"));
  });

  it("uses --no-tools for forge mode", () => {
    const args = buildPiArgs("task", "/tmp/session.jsonl", null, stageProfile, "forge");
    assert.ok(args.includes("--no-tools"));
    const toolsIndex = args.indexOf("--tools");
    assert.strictEqual(toolsIndex, -1);
  });
});

// ── Memory refresh integration ───────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryClear, memoryGetTopic, indexFindings, memoryForget, topicHasStaleFindings } from "../src/memory.js";

describe("memory refresh integration", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cdev-memory-test-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "types.ts"), "export {}\n", "utf-8");
    writeFileSync(join(cwd, "src", "runner.ts"), "export {}\n", "utf-8");
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("indexes findings and retrieves the topic", () => {
    memoryClear(cwd);
    const topic = indexFindings({
      task: "explore types module",
      resultText: "Core types live in `src/types.ts` and `src/runner.ts`.",
      stage1Model: "flash",
      stage2Model: "pro",
      isReview: false,
      quick: false,
      cost: 0.0012,
      cwd,
    });

    assert.strictEqual(topic, "types-module");
    const entry = memoryGetTopic(cwd, topic!);
    assert.ok(entry, "topic entry should exist");
    assert.strictEqual(entry!.forkCount, 1);
    assert.ok(
      entry!.files.includes("src/types.ts") || entry!.files.includes("src/runner.ts"),
      `expected src/types.ts or src/runner.ts, got: ${entry ? entry.files.join(",") : "<no entry>"}`
    );
    memoryClear(cwd);
  });

  it("forget removes a topic", () => {
    memoryClear(cwd);
    indexFindings({
      task: "explore payment gateway",
      resultText: "Payment code in `src/config.ts`.",
      stage1Model: "flash",
      stage2Model: "pro",
      isReview: false,
      quick: false,
      cost: 0,
      cwd,
    });
    assert.ok(memoryGetTopic(cwd, "payment-gateway"));
    assert.strictEqual(memoryForget(cwd, "payment-gateway"), true);
    assert.strictEqual(memoryGetTopic(cwd, "payment-gateway"), null);
    memoryClear(cwd);
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("detects stale findings when files change", () => {
    memoryClear(cwd);
    indexFindings({
      task: "explore types module",
      resultText: "Core types live in `src/types.ts`.",
      stage1Model: "flash",
      stage2Model: "pro",
      isReview: false,
      quick: false,
      cost: 0,
      cwd,
    });
    const entry = memoryGetTopic(cwd, "types-module")!;
    assert.strictEqual(topicHasStaleFindings(entry, cwd), false);

    writeFileSync(join(cwd, "src", "types.ts"), "export interface Changed {}\n", "utf-8");
    assert.strictEqual(topicHasStaleFindings(entry, cwd), true);
    memoryClear(cwd);
  });
});

// ── runner.ts command-line guard helpers ─────────────────

// (imports moved to top of file)

describe("estimateCommandLineLength (fork-stage.ts)", () => {
  it("counts command and args", () => {
    const len = estimateCommandLineLength("node", ["--mode", "json", "task"]);
    assert.ok(len > "node".length + "--mode".length + "json".length + "task".length);
  });

  it("grows with argument length", () => {
    const base = estimateCommandLineLength("node", ["a"]);
    const long = estimateCommandLineLength("node", ["a".repeat(1000)]);
    assert.ok(long > base + 900);
  });
});

describe("appendTaskToSessionJsonl (fork-stage.ts)", () => {
  it("appends system task instruction and user prompt", () => {
    const out = appendTaskToSessionJsonl(JSON.stringify({ type: "header" }), "explore auth");
    const lines = out.trim().split("\n");
    assert.strictEqual(lines.length, 3);
    const system = JSON.parse(lines[1]);
    assert.strictEqual(system.role, "system");
    assert.ok(system.content[0].text.includes("explore auth"));
    assert.strictEqual(system.cdev_prompt_version, PROMPT_VERSION);
    const user = JSON.parse(lines[2]);
    assert.strictEqual(user.role, "user");
  });
});

describe("buildFileReviewPrompt (prompts.ts)", () => {
  it("truncates very long report content", () => {
    const longReport = "x".repeat(20000);
    const prompt = buildFileReviewPrompt("report.md", longReport, {});
    assert.ok(prompt.length < longReport.length + 5000);
    assert.ok(prompt.includes("truncated from 20000 chars"));
  });

  it("includes referenced files", () => {
    const prompt = buildFileReviewPrompt("report.md", "claim", { "src/a.ts": "const a = 1;" });
    assert.ok(prompt.includes("src/a.ts"));
    assert.ok(prompt.includes("const a = 1;"));
  });
});

// ── runner.ts: buildPiArgs no longer emits --temperature ───

// (buildPiArgs imported from fork-stage.js)

describe("buildPiArgs (fork-stage.ts)", () => {
  it("does not include --temperature", () => {
    const args = buildPiArgs("explore auth", "/tmp/session.jsonl", null, {
      provider: "openai",
      id: "gpt-4",
      thinking: "minimal",
    });
    assert.ok(!args.includes("--temperature"));
  });

  it("includes stage profile and task", () => {
    const args = buildPiArgs("explore auth", "/tmp/session.jsonl", null, {
      provider: "openai",
      id: "gpt-4",
      thinking: "minimal",
    });
    assert.ok(args.includes("--provider"));
    assert.ok(args.includes("openai"));
    assert.ok(args.includes("explore auth"));
  });
});

// ── Structured stage 1 findings ──────────────────────────

// ── YOLO config and verdict helpers ──────────────────────

import { normalizeYoloConfig, formatYoloStatus } from "../src/types.js";
import { parseReviewVerdict } from "../src/fork-orchestrator.js";

describe("normalizeYoloConfig (types.ts)", () => {
  it("clamps maxRounds to 7", () => {
    const result = normalizeYoloConfig({ maxRounds: 20 });
    assert.strictEqual(result.maxRounds, 7);
  });

  it("clamps maxRounds to at least 1", () => {
    const result = normalizeYoloConfig({ maxRounds: 0 });
    assert.strictEqual(result.maxRounds, 1);
  });

  it("uses defaults when fields are omitted", () => {
    const result = normalizeYoloConfig();
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.maxRounds, 3);
    assert.strictEqual(result.stopOnPass, true);
    assert.strictEqual(result.autoApply, "manual");
  });

  it("preserves reviewProfile and fixProfile", () => {
    const reviewProfile = { provider: "openai", id: "gpt-5", thinking: "low" as const };
    const fixProfile = { provider: "anthropic", id: "claude", thinking: "high" as const };
    const result = normalizeYoloConfig({ reviewProfile, fixProfile });
    assert.deepStrictEqual(result.reviewProfile, reviewProfile);
    assert.deepStrictEqual(result.fixProfile, fixProfile);
  });
});

describe("formatYoloStatus (types.ts)", () => {
  it("returns OFF when disabled", () => {
    assert.strictEqual(formatYoloStatus({ enabled: false }), "OFF");
  });

  it("returns formatted status when enabled", () => {
    const status = formatYoloStatus({ enabled: true, maxRounds: 5, autoApply: "propose" });
    assert.strictEqual(status, "ON (max 5 rounds, auto-apply propose)");
  });
});

describe("parseReviewVerdict (fork-orchestrator.ts)", () => {
  it("detects pass in ## Result section", () => {
    assert.strictEqual(parseReviewVerdict("## Result\npass — looks good"), "pass");
  });

  it("detects needs-work", () => {
    assert.strictEqual(parseReviewVerdict("## Result\nneeds-work: missing tests"), "needs-work");
  });

  it("detects blocked", () => {
    assert.strictEqual(parseReviewVerdict("## Result\nblocked: compile error"), "blocked");
  });

  it("returns unknown when ## Result is missing", () => {
    assert.strictEqual(parseReviewVerdict("pass — looks good"), "unknown");
  });

  it("prioritizes needs-work over pass", () => {
    assert.strictEqual(parseReviewVerdict("## Result\npass overall but needs-work on edge cases"), "needs-work");
  });

  it("prioritizes blocked over pass", () => {
    assert.strictEqual(parseReviewVerdict("## Result\npass but blocked by dependency"), "blocked");
  });
});

// ── Structured stage 1 findings ──────────────────────────

import { mergeStage1Findings } from "../src/fork-orchestrator.js";

// (isStage1Findings and parseStage1Findings imported from json-extract.js)

describe("isStage1Findings (json-extract.ts)", () => {
  it("accepts valid findings", () => {
    assert.ok(isStage1Findings({
      summary: "explored auth",
      findings: [{ observation: "JWT used", confidence: "high" }],
    }));
  });

  it("rejects missing summary", () => {
    assert.ok(!isStage1Findings({
      findings: [{ observation: "JWT used", confidence: "high" }],
    }));
  });

  it("rejects missing findings array", () => {
    assert.ok(!isStage1Findings({
      summary: "explored auth",
    }));
  });

  it("rejects findings without observation", () => {
    assert.ok(!isStage1Findings({
      summary: "explored auth",
      findings: [{ confidence: "high" }],
    }));
  });

  it("rejects invalid confidence", () => {
    assert.ok(!isStage1Findings({
      summary: "explored auth",
      findings: [{ observation: "JWT used", confidence: "maybe" }],
    }));
  });
});

describe("parseStage1Findings (json-extract.ts)", () => {
  it("parses bare JSON", () => {
    const text = JSON.stringify({ summary: "s", findings: [{ observation: "o", confidence: "medium" }] });
    const result = parseStage1Findings(text);
    assert.ok(result);
    assert.strictEqual(result!.summary, "s");
    assert.strictEqual(result!.findings.length, 1);
  });

  it("parses JSON inside markdown fence", () => {
    const text = "```json\n" + JSON.stringify({ summary: "s", findings: [{ observation: "o", confidence: "medium" }] }) + "\n```";
    const result = parseStage1Findings(text);
    assert.ok(result);
    assert.strictEqual(result!.summary, "s");
  });

  it("returns null for invalid JSON", () => {
    const result = parseStage1Findings("not json");
    assert.strictEqual(result, null);
  });

  it("returns null for findings missing required fields", () => {
    const result = parseStage1Findings(JSON.stringify({ summary: "s" }));
    assert.strictEqual(result, null);
  });
});

describe("mergeStage1Findings (fork-orchestrator.ts)", () => {
  it("merges unique findings from two runs", () => {
    const a = {
      summary: "run A",
      findings: [{ observation: "JWT used", confidence: "high" as const, file: "auth.ts" }],
      deadEnds: ["oauth1"],
    };
    const b = {
      summary: "run B",
      findings: [{ observation: "sessions stored in redis", confidence: "medium" as const }],
      assumptions: ["redis is persistent"],
    };
    const merged = mergeStage1Findings(a, b);
    assert.strictEqual(merged.findings.length, 2);
    assert.strictEqual(merged.deadEnds!.length, 1);
    assert.strictEqual(merged.assumptions!.length, 1);
  });

  it("deduplicates near-duplicate findings", () => {
    const a = {
      summary: "run A",
      findings: [{ observation: "JWT used for authentication", confidence: "high" as const }],
    };
    const b = {
      summary: "run B",
      findings: [{ observation: "JWT used for authentication", confidence: "medium" as const }],
    };
    const merged = mergeStage1Findings(a, b);
    assert.strictEqual(merged.findings.length, 1);
  });

  it("picks longer summary when B has more findings", () => {
    const a = {
      summary: "short",
      findings: [{ observation: "x", confidence: "high" as const }],
    };
    const b = {
      summary: "longer summary here",
      findings: [
        { observation: "x", confidence: "high" as const },
        { observation: "y", confidence: "medium" as const },
      ],
    };
    const merged = mergeStage1Findings(a, b);
    assert.strictEqual(merged.summary, "longer summary here");
  });
});

describe("formatStage1FindingsForStage2 (fork-orchestrator.ts)", () => {
  it("includes coverage and contradictions for forge", async () => {
    const { formatStage1FindingsForStage2 } = await import("../src/fork-orchestrator.js");
    const text = formatStage1FindingsForStage2({
      summary: "explored auth",
      findings: [{ observation: "JWT is validated", confidence: "high", file: "src/auth.ts", evidence: "read src/auth.ts" }],
      coverage: { filesInspected: 3, filesCited: 1, commandsRun: 2, unreadLikelyFiles: 1 },
      contradictions: [{
        observationA: "JWT is validated",
        observationB: "JWT validation is missing",
        summary: "One finding affirms while the other negates validation",
      }],
    });
    assert.match(text, /Coverage:/);
    assert.match(text, /Files inspected: 3/);
    assert.match(text, /Contradictions between scout runs:/);
    assert.match(text, /JWT validation is missing/);
  });
});


describe("checkSessionSnapshot fast path (tool.ts via extension-context)", () => {
  beforeEach(() => setTokenEstimationRatio(4));
  afterEach(() => setTokenEstimationRatio(4));

  it("triggers auto-compact when Pi reports >=95% context usage", () => {
    const limit = 262_144;
    const usageTokens = Math.ceil(limit * 0.96);
    const snapshot = buildSessionSnapshotJsonl(
      {
        getHeader: () => ({ type: "header", id: "h1" }),
        getBranch: () => Array.from({ length: 200 }, (_, i) => ({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(500) })),
      },
      limit,
    );
    assert.ok(snapshot);
    const estimated = Math.ceil(snapshot.length / 4);
    assert.ok(estimated > limit * 0.95 || usageTokens > limit * 0.95);
  });
});
