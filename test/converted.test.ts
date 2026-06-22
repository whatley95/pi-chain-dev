/**
 * Unit tests for converted and new pi-chain-dev modules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInheritedCliArgs } from "../src/runner-cli.js";
import { processPiEvent, processPiJsonLine, getFinalAssistantText, stableStringify } from "../src/runner-events.js";
import { buildSessionSnapshotJsonl, resolveStageProfiles, formatResultContent } from "../src/extension-context.js";
import { emptyUsage, emptyFailedResult } from "../src/types.js";

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

// ── Memory refresh integration ───────────────────────────

import { memoryClear, memoryGetTopic, indexFindings, memoryForget } from "../src/memory.js";

describe("memory refresh integration", () => {
  const cwd = process.cwd();

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
    assert.ok(entry);
    assert.strictEqual(entry!.forkCount, 1);
    assert.ok(entry!.files.includes("src/types.ts") || entry!.files.includes("src/runner.ts"));
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
  });
});

// ── Structured stage 1 findings ──────────────────────────

import { isStage1Findings } from "../src/types.js";
import { parseStage1Findings, mergeStage1Findings } from "../src/runner.js";

describe("isStage1Findings (types.ts)", () => {
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

describe("parseStage1Findings (runner.ts)", () => {
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

describe("mergeStage1Findings (runner.ts)", () => {
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
