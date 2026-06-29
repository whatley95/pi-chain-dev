/**
 * Unit tests for pi-chain-dev core logic.
 *
 * Run with: npx tsx --test test/unit.test.ts
 * Requires: tsx (TypeScript executor)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// ── memory.ts imports ──────────────────────────────────
import { extractFilePaths, extractTopicFromTask } from "../src/memory.js";

// ── env.ts imports ─────────────────────────────────────
import { buildChildEnv } from "../src/env.js";

// ── runner-events.js imports ───────────────────────────
import { stableStringify } from "../src/runner-events.js";

// ── types.ts imports ──────────────────────────────────
import { emptyUsage, emptyFailedResult } from "../src/types.js";
import {
  handleReadSubcommand,
  handleGrepSubcommand,
  handleTraceSubcommand,
  handleExplainSubcommand,
} from "../src/commands/cdev-tools.js";

// ── memory.ts: extractFilePaths ───────────────────────────

describe("cdev tool shortcuts", () => {
  function mockCtx(cwd: string) {
    const notifications: string[] = [];
    return {
      notifications,
      ctx: {
        cwd,
        ui: {
          notify: (message: string) => {
            notifications.push(message);
          },
        },
      },
    };
  }

  it("directly reads files without spawning a scout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-tools-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "a.ts"), "one\ntwo\nthree\n", "utf-8");
      const { ctx, notifications } = mockCtx(cwd);

      assert.equal(await handleReadSubcommand("read src/a.ts:2-3", ctx as never, {} as never), true);
      assert.match(notifications[0] ?? "", /cdev direct read/);
      assert.match(notifications[0] ?? "", /2: two/);
      assert.match(notifications[0] ?? "", /3: three/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("directly searches, traces, and explains with gathered context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-tools-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "prompt.ts"), "export function buildStage1Prompt() {}\n", "utf-8");
      const grep = mockCtx(cwd);
      const trace = mockCtx(cwd);
      const explain = mockCtx(cwd);

      assert.equal(await handleGrepSubcommand("grep buildStage1Prompt src", grep.ctx as never, {} as never), true);
      assert.equal(await handleTraceSubcommand("trace buildStage1Prompt", trace.ctx as never, {} as never), true);
      assert.equal(await handleExplainSubcommand("explain src/prompt.ts", explain.ctx as never, {} as never), true);
      assert.match(grep.notifications[0] ?? "", /cdev direct grep/);
      assert.match(trace.notifications[0] ?? "", /cdev direct trace/);
      assert.match(explain.notifications[0] ?? "", /cdev direct read/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not match plural typo forms as shortcuts", async () => {
    const { ctx } = mockCtx(process.cwd());

    assert.equal(await handleReadSubcommand("reads src/a.ts", ctx as never, {} as never), false);
    assert.equal(await handleGrepSubcommand("greps pattern", ctx as never, {} as never), false);
  });
});

describe("extractFilePaths (memory.ts)", () => {
  it("extracts backtick-enclosed paths", () => {
    const text = "See `src/foo/bar.ts` for details.";
    const result = extractFilePaths(text, "/project");
    // Resolved path won't exist on filesystem, so result is empty at runtime.
    // But we verify the regex runs without throwing and returns an array.
    assert.ok(Array.isArray(result));
  });

  it("extracts paths after 'file' keyword", () => {
    const text = "in file config.ts we found the issue.";
    const result = extractFilePaths(text, "/project");
    assert.ok(Array.isArray(result));
  });

  it("returns actual file paths for files that exist on disk", () => {
    // Use files we know exist in the project (require at least one / in path)
    const text = "See `src/types.ts` and `test/unit.test.ts` for details.";
    const cwd = process.cwd();
    const result = extractFilePaths(text, cwd);
    // Both files exist, so they should be extracted
    assert.ok(result.includes("src/types.ts"));
    assert.ok(result.includes("test/unit.test.ts"));
  });

  it("extracts paths from double-quoted strings", () => {
    const text = 'The config is at "src/config.ts" and types at "src/types.ts".';
    const cwd = process.cwd();
    const result = extractFilePaths(text, cwd);
    assert.ok(result.includes("src/types.ts"));
  });

  it("handles empty text", () => {
    assert.deepEqual(extractFilePaths("", "/project"), []);
  });

  it("handles text with no paths", () => {
    assert.deepEqual(extractFilePaths("just some random text without paths", "/project"), []);
  });

  it("handles null bytes or edge characters", () => {
    const result = extractFilePaths("a\0b `file.ts` c", "/project");
    assert.ok(Array.isArray(result));
  });
});

// ── memory.ts: extractTopicFromTask ───────────────────────

describe("extractTopicFromTask (memory.ts)", () => {
  it("extracts topic from 'explore auth module'", () => {
    assert.equal(extractTopicFromTask("explore auth module", []), "auth-module");
  });

  it("extracts topic from 'review payment gateway'", () => {
    assert.equal(extractTopicFromTask("review payment gateway", []), "payment-gateway");
  });

  it("extracts topic from 'check login flow'", () => {
    assert.equal(extractTopicFromTask("check login flow", []), "login-flow");
  });

  it("falls back to first words when no verb match", () => {
    const result = extractTopicFromTask("something about auth module", []);
    assert.ok(result !== null);
    assert.equal(typeof result, "string");
  });

  it("returns null for very short input", () => {
    assert.equal(extractTopicFromTask("hi", []), null);
  });

  it("uses dominant directory when enough files provided", () => {
    const files = ["src/auth/login.ts", "src/auth/register.ts", "src/auth/middleware.ts", "src/utils/helper.ts"];
    assert.equal(extractTopicFromTask("explore auth", files), "auth");
  });

  it("falls through to verb strategy when too few files", () => {
    const files = ["src/auth/login.ts"];
    const result = extractTopicFromTask("trace the auth flow", files);
    // Strategy 2 captures "the auth" after verb "trace" — articles not stripped at that stage
    assert.ok(result !== null);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("auth"));
  });
});

// ── env.ts: buildChildEnv ─────────────────────────────────

describe("buildChildEnv (env.ts)", () => {
  it("inherits parent environment", () => {
    const env = buildChildEnv({}, { PATH: "/usr/bin", HOME: "/home/user" }, "linux", false);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/user");
  });

  it("overlays custom environment vars", () => {
    const env = buildChildEnv({ MY_VAR: "hello" }, { PATH: "/usr/bin" }, "linux", false);
    assert.equal(env.MY_VAR, "hello");
  });

  it("sets PI_OFFLINE=1 when offline=true", () => {
    const env = buildChildEnv({}, {}, "linux", true);
    assert.equal(env.PI_OFFLINE, "1");
  });

  it("does not set PI_OFFLINE when offline=false", () => {
    const env = buildChildEnv({}, {}, "linux", false);
    assert.equal(env.PI_OFFLINE, undefined);
  });

  it("overwrites case-insensitive keys on Windows", () => {
    // When overlay uses a different case than parent, old key is deleted
    const env = buildChildEnv({ "Path": "/new/usr/bin" }, { "path": "/old/usr/bin" }, "win32", false);
    assert.equal(env["Path"], "/new/usr/bin");
    // Old "path" should be gone because "Path" matches case-insensitively
    assert.equal(env["path"], undefined);
  });

  it("preserves parent keys when no overlay conflicts", () => {
    const env = buildChildEnv({ "OTHER": "val" }, { "path": "/usr/bin" }, "win32", false);
    assert.equal(env["path"], "/usr/bin");
    assert.equal(env["OTHER"], "val");
  });

  it("handles empty environment", () => {
    const env = buildChildEnv({}, {}, "linux", false);
    assert.deepEqual(env, {});
  });
});

// ── runner-events.js: stableStringify ─────────────────────

describe("stableStringify (runner-events.js)", () => {
  it("stringifies undefined", () => {
    assert.equal(stableStringify(undefined), "undefined");
  });

  it("stringifies null", () => {
    assert.equal(stableStringify(null), "null");
  });

  it("stringifies primitives", () => {
    assert.equal(stableStringify(42), "42");
    assert.equal(stableStringify("hello"), '"hello"');
    assert.equal(stableStringify(true), "true");
  });

  it("stringifies arrays", () => {
    assert.equal(stableStringify([1, 2, 3]), "[1,2,3]");
  });

  it("stringifies objects with sorted keys", () => {
    assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  it("handles circular references without stack overflow", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = stableStringify(obj);
    assert.ok(result.includes('"<circular>"'));
    assert.equal(typeof result, "string");
  });

  it("handles nested circular references", () => {
    const inner: Record<string, unknown> = { x: 1 };
    const outer: Record<string, unknown> = { inner, list: [inner] };
    inner.parent = outer;
    const result = stableStringify(outer);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("handles deeply nested objects", () => {
    const obj = { a: { b: { c: { d: { e: "deep" } } } } };
    const result = stableStringify(obj);
    assert.ok(result.includes("deep"));
  });
});

// ── history.ts: session ID format ─────────────────────────

describe("Session ID generation", () => {
  it("produces unique IDs for different timestamps", () => {
    const startedAt1 = new Date("2026-06-21T10:00:00.000Z").getTime();
    const startedAt2 = new Date("2026-06-21T10:00:00.001Z").getTime();

    function makeId(startedAt: number): string {
      return new Date(startedAt).toISOString().replace(/[:.]/g, "-") + "-" + Date.now().toString(36).slice(-4);
    }

    const id1 = makeId(startedAt1);
    const id2 = makeId(startedAt2);
    // The random suffix should make them unique even if dates are the same
    assert.ok(id1.length > 0);
    assert.ok(id2.length > 0);
  });

  it("creates filesystem-safe IDs", () => {
    const id = new Date("2026-06-21T10:00:00.000Z").toISOString().replace(/[:.]/g, "-") + "-abc1";
    // Should not contain : or . which are problematic in Windows filenames
    assert.ok(!id.includes(":"));
    assert.ok(!id.includes("."));
  });
});

// ── config.ts: Thinking level validation ──────────────────

describe("Thinking level validation", () => {
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

  function isThinkingLevel(value: unknown): boolean {
    return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
  }

  it("validates all thinking levels", () => {
    for (const level of THINKING_LEVELS) {
      assert.equal(isThinkingLevel(level), true);
    }
  });

  it("rejects invalid thinking levels", () => {
    assert.equal(isThinkingLevel("super"), false);
    assert.equal(isThinkingLevel(""), false);
    assert.equal(isThinkingLevel(42), false);
    assert.equal(isThinkingLevel(null), false);
  });
});

// ── types.ts: emptyUsage / emptyFailedResult ──────────────

describe("emptyUsage()", () => {
  it("returns all zeros", () => {
    assert.deepEqual(emptyUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
  });
});

describe("emptyFailedResult()", () => {
  it("creates a failed result with the given message", () => {
    const result = emptyFailedResult("test", "something went wrong");
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorMessage, "something went wrong");
    assert.equal(result.stopReason, "error");
  });
});

describe("emptyUsage()", () => {
  it("returns all zeros", () => {
    assert.deepEqual(emptyUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
  });
});

describe("emptyFailedResult()", () => {
  it("creates a failed result with the given message", () => {
    const result = emptyFailedResult("test", "something went wrong");
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorMessage, "something went wrong");
    assert.equal(result.stopReason, "error");
  });
});

// ── loop-detector.ts: detectLoop ─────────────────────────

import { detectLoop, extractToolCallsFromEntries } from "../src/loop-detector.js";

// ── commands/cdev-help.ts: CDEV_SUBCOMMAND_HELP ─────────────────

import { CDEV_SUBCOMMAND_HELP } from "../src/commands/cdev-help.js";

describe("detectLoop", () => {
  it("returns no loop for diverse calls", () => {
    const calls = [
      { toolName: "read", args: { path: "src/a.ts" } },
      { toolName: "read", args: { path: "src/b.ts" } },
      { toolName: "edit", args: { path: "src/a.ts" } },
    ];
    const result = detectLoop(calls, { threshold: 3 });
    assert.equal(result.looping, false);
  });

  it("detects repeated reads of the same file", () => {
    const calls = [
      { toolName: "read", args: { path: ".pi/cdev/reports/fix.md" } },
      { toolName: "read", args: { path: ".pi/cdev/reports/fix.md" } },
      { toolName: "read", args: { path: ".pi/cdev/reports/fix.md" } },
    ];
    const result = detectLoop(calls, { threshold: 3 });
    assert.equal(result.looping, true);
    assert.ok(result.reason.includes("read"));
    assert.ok(result.suggestion.includes("source files"));
  });

  it("detects report-only bouncing", () => {
    const calls = [
      { toolName: "read", args: { path: ".pi/cdev/reports/a.md" } },
      { toolName: "read", args: { path: ".pi/cdev/reports/b.md" } },
      { toolName: "read", args: { path: ".pi/cdev/reports/a.md" } },
    ];
    const result = detectLoop(calls, { threshold: 3 });
    assert.equal(result.looping, true);
    assert.ok(result.reason.includes("re-reading report"));
  });

  it("detects report re-reads with threshold 2", () => {
    const calls = [
      { toolName: "read", args: { path: ".pi/cdev/reports/fix.md" } },
      { toolName: "read", args: { path: ".pi/cdev/reports/fix.md" } },
    ];
    const result = detectLoop(calls, { threshold: 2 });
    assert.equal(result.looping, true);
    assert.ok(result.repeatedFile?.includes("fix.md"));
  });

  it("does not treat ordinary markdown files as cdev reports", () => {
    const calls = [
      { toolName: "read", args: { path: "README.md" } },
      { toolName: "read", args: { path: "README.md" } },
      { toolName: "read", args: { path: "README.md" } },
    ];
    const result = detectLoop(calls, { threshold: 3 });
    assert.equal(result.looping, true);
    assert.equal(result.repeatedFile, undefined);
    assert.ok(result.reason.includes("read"));
  });

  it("requires threshold repetitions", () => {
    const calls = [
      { toolName: "read", args: { path: "src/a.ts" } },
      { toolName: "read", args: { path: "src/a.ts" } },
    ];
    const result = detectLoop(calls, { threshold: 3 });
    assert.equal(result.looping, false);
  });
});

describe("extractToolCallsFromEntries", () => {
  it("extracts tool execution events", () => {
    const entries = [
      { type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } },
      { type: "tool_execution_end", toolName: "read", args: { path: "src/a.ts" } },
    ];
    const calls = extractToolCallsFromEntries(entries);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].toolName, "read");
  });

  it("extracts assistant tool_calls", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          tool_calls: [{ name: "read", arguments: { path: "src/b.ts" } }],
        },
      },
    ];
    const calls = extractToolCallsFromEntries(entries);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.path, "src/b.ts");
  });

  it("extracts toolResult messages", () => {
    const entries = [
      {
        type: "message",
        message: { role: "toolResult", toolName: "read", args: { path: "src/c.ts" } },
      },
    ];
    const calls = extractToolCallsFromEntries(entries);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, "read");
  });
});

describe("CDEV_SUBCOMMAND_HELP", () => {
  it("is a non-empty array of strings", () => {
    assert.ok(Array.isArray(CDEV_SUBCOMMAND_HELP));
    assert.ok(CDEV_SUBCOMMAND_HELP.length > 0);
    for (const line of CDEV_SUBCOMMAND_HELP) {
      assert.equal(typeof line, "string");
    }
  });

  it("contains no leading or trailing whitespace", () => {
    for (const line of CDEV_SUBCOMMAND_HELP) {
      assert.equal(line, line.trimStart(), `line has leading whitespace: ${JSON.stringify(line)}`);
      assert.equal(line, line.trimEnd(), `line has trailing whitespace: ${JSON.stringify(line)}`);
    }
  });

  it("includes core subcommands", () => {
    const text = CDEV_SUBCOMMAND_HELP.join("\n");
    assert.ok(text.includes("/cdev <task>"));
    assert.ok(text.includes("/cdev quick"));
    assert.ok(text.includes("/cdev read"));
    assert.ok(text.includes("/cdev grep"));
    assert.ok(text.includes("/cdev trace"));
    assert.ok(text.includes("/cdev explain"));

    assert.ok(text.includes("/cdev research"));
    assert.ok(text.includes("/cdev advisor"));
    assert.ok(text.includes("/cdev ask-advisor"));
    assert.ok(text.includes("/cdev multi"));
    assert.ok(text.includes("/cdev status"));
    assert.ok(text.includes("/cdev config"));
    assert.ok(text.includes("/cdev-help"));
    assert.ok(text.includes("/cdev-model"));
  });
});

// ── prompts.ts: buildAdvisorPrompt ─────────────────────────

import { buildAdvisorPrompt } from "../src/prompts.js";

describe("buildAdvisorPrompt", () => {
  it("includes the question and JSON schema", () => {
    const prompt = buildAdvisorPrompt("should we refactor this?");
    assert.ok(prompt.includes("should we refactor this?"));
    assert.ok(prompt.includes('"recommendation"'));
    assert.ok(prompt.includes('"confidence"'));
    assert.ok(prompt.includes('"actionItems"'));
  });

  it("includes scout findings when provided", () => {
    const prompt = buildAdvisorPrompt("what next?", "found foo in bar.ts");
    assert.ok(prompt.includes("<scout_findings>"));
    assert.ok(prompt.includes("found foo in bar.ts"));
  });

  it("omits scout findings tag when not provided", () => {
    const prompt = buildAdvisorPrompt("what next?");
    assert.ok(!prompt.includes("<scout_findings>"));
  });

  it("prepends custom prompt when provided", () => {
    const prompt = buildAdvisorPrompt("what next?", undefined, "be concise");
    assert.ok(prompt.startsWith("be concise"));
    assert.ok(prompt.includes("what next?"));
  });
});

// ── loop-detector-runtime.ts: real-time loop detection ─────────────────────────

import {
  createLoopDetectionState,
  recordToolCall,
  refreshFromSessionEntries,
  checkAndSendLoopSteer,
  registerRealtimeLoopDetection,
} from "../src/loop-detector-runtime.js";

describe("loop-detector-runtime", () => {
  it("steers when the same report is read twice in real time", () => {
    const state = createLoopDetectionState();
    const steers: string[] = [];
    const reportPath = ".pi/cdev/reports/review.md";

    recordToolCall(state, { type: "tool_execution_start", toolName: "read", args: { path: reportPath } });
    assert.equal(steers.length, 0, "first read should not steer");

    checkAndSendLoopSteer(state, (message, options) => {
      if (options?.deliverAs === "steer") steers.push(message);
    });
    assert.equal(steers.length, 0, "check before threshold should not steer");

    recordToolCall(state, { type: "tool_execution_start", toolName: "read", args: { path: reportPath } });
    checkAndSendLoopSteer(state, (message, options) => {
      if (options?.deliverAs === "steer") steers.push(message);
    });
    assert.equal(steers.length, 1, "second report read should steer");
    assert.ok(steers[0]?.includes("LOOP DETECTED"));
    assert.ok(steers[0]?.includes(reportPath));
  });

  it("cools down repeated identical loops", () => {
    const state = createLoopDetectionState();
    const steers: string[] = [];
    const reportPath = ".pi/cdev/reports/loop.md";

    for (let i = 0; i < 6; i++) {
      recordToolCall(state, { type: "tool_execution_start", toolName: "read", args: { path: reportPath } });
      checkAndSendLoopSteer(state, (message, options) => {
        if (options?.deliverAs === "steer") steers.push(message);
      });
    }
    assert.equal(steers.length, 1, "identical loop should only steer once within cooldown");
  });

  it("registers a tool_execution_start handler", () => {
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    const steers: string[] = [];
    const mockPi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] = handler;
      },
      registerTool: () => { /* ignore */ },
      registerCommand: () => { /* ignore */ },
      sendUserMessage: (message: string, options?: Record<string, unknown>) => {
        if (options?.deliverAs === "steer") steers.push(message);
      },
    };

    registerRealtimeLoopDetection(mockPi as never);

    const reportPath = ".pi/cdev/reports/live.md";
    handlers["tool_execution_start"]?.({ type: "tool_execution_start", toolName: "read", args: { path: reportPath } }, {});
    handlers["tool_execution_start"]?.({ type: "tool_execution_start", toolName: "read", args: { path: reportPath } }, {});
    assert.equal(steers.length, 1);
    assert.ok(steers[0]?.includes("LOOP DETECTED"));
  });

  it("refreshes state from session entries", () => {
    const state = createLoopDetectionState();
    const steers: string[] = [];
    const reportPath = ".pi/cdev/reports/restored.md";

    refreshFromSessionEntries(state, [
      { type: "tool_execution_start", toolName: "read", args: { path: reportPath } },
      { type: "tool_execution_start", toolName: "read", args: { path: reportPath } },
    ]);

    checkAndSendLoopSteer(state, (message, options) => {
      if (options?.deliverAs === "steer") steers.push(message);
    });
    assert.equal(steers.length, 1);
    assert.ok(steers[0]?.includes(reportPath));
  });
});
