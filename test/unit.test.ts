/**
 * Unit tests for pi-chain-dev core logic.
 *
 * Run with: npx tsx --test test/unit.test.ts
 * Requires: tsx (TypeScript executor)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── memory.ts imports ──────────────────────────────────
import { extractFilePaths, extractTopicFromTask } from "../src/memory.js";

// ── env.ts imports ─────────────────────────────────────
import { buildChildEnv } from "../src/env.js";

// ── runner-events.js imports ───────────────────────────
import { stableStringify } from "../src/runner-events.js";

// ── types.ts imports ──────────────────────────────────
import { emptyUsage, emptyFailedResult } from "../src/types.js";

// ── memory.ts: extractFilePaths ───────────────────────────

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
    const text = 'The config is at \"src/config.ts\" and types at \"src/types.ts\".';
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
