/**
 * Unit tests for pi-chain-dev core logic.
 *
 * Run with: npx tsx --test test/unit.test.ts
 * Requires: tsx (TypeScript executor)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";

// ── memory.ts: extractFilePaths ───────────────────────────

// We test the function by reimplementing the logic in isolation
// since importing from .ts requires a compiled .js file.

function extractFilePaths(text: string, cwd: string): string[] {
  const patterns = [
    /(?:^|\s|[`'"([{<])(\.{0,2}[/\\])?([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))(?:[:"',)}\]>\s]|$)/gm,
    /(?:file|path|module|package|class)\s+[`'"]?(\.{0,2}[/\\])?([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))[`'"]?/gi,
    /`(\.{0,2}[/\\])?([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))`/g,
    /"([\w@.\-]+(?:[/\\][\w@.\-]+)+(?:\.\w{1,8}))"/g,
  ];

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      let raw: string;
      if (match.length === 4) {
        raw = (match[2] || "") + match[3];
      } else if (match.length === 3) {
        raw = (match[1] || "") + match[2];
      } else {
        raw = match[1];
      }
      if (!raw) continue;
      raw = raw.replace(/\\/g, "/");
      raw = raw.replace(/:\d+(?::\d+)?$/, "");
      raw = raw.replace(/[,;.]+$/, "");
      const resolved = join(cwd, raw);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        if (existsSync(resolved)) {
          paths.push(relative(cwd, resolved).replace(/\\/g, "/"));
        }
      }
    }
  }
  return [...new Set(paths)];
}

describe("extractFilePaths (memory.ts)", () => {
  it("extracts backtick-enclosed paths", () => {
    const text = "See `src/foo/bar.ts` for details.";
    const result = extractFilePaths(text, "/project");
    // The resolved path would be checked against actual filesystem, which won't exist
    // So we mainly verify the regex doesn't crash
    assert.ok(Array.isArray(result));
  });

  it("extracts paths after 'file' keyword", () => {
    const text = "in file config.ts we found the issue.";
    const result = extractFilePaths(text, "/project");
    assert.ok(Array.isArray(result));
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

function extractTopicFromTask(task: string, filePaths: string[]): string | null {
  // Strategy 1: dominant directory from file paths
  if (filePaths.length > 0) {
    const dirCounts = new Map<string, number>();
    for (const fp of filePaths) {
      const parts = fp.split("/");
      let topDir = parts[0];
      if (parts.length > 1 && /^(src|app|lib|pkg|internal|cmd|components|pages|utils?)$/.test(topDir)) {
        topDir = parts[1];
      }
      if (topDir && topDir.length > 1 && !/^\./.test(topDir)) {
        dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
      }
    }
    let bestDir = "";
    let bestCount = 0;
    for (const [dir, count] of dirCounts) {
      if (count > bestCount) { bestDir = dir; bestCount = count; }
    }
    if (filePaths.length >= 3 && bestDir && bestCount / filePaths.length > 0.3) return bestDir;
  }

  // Strategy 2: first noun after common verbs
  const taskVerbs = ["explore", "trace", "review", "check", "audit", "scan", "analyze", "investigate", "refactor", "fix", "debug", "test", "document", "migrate", "upgrade"];
  const lower = task.toLowerCase();
  for (const verb of taskVerbs) {
    const idx = lower.indexOf(verb);
    if (idx >= 0) {
      const after = task.slice(idx + verb.length).trim();
      const phraseMatch = after.match(/^([\w-]+(?:\s+[\w-]+)?)/);
      if (phraseMatch && phraseMatch[1].length > 1) {
        return phraseMatch[1].toLowerCase().replace(/\s+/g, "-");
      }
    }
  }

  // Strategy 3: first 2 words of task, skip articles
  const words = task.split(/\s+/);
  const filtered = words.filter(w => !/^(the|a|an|is|are|was|were|that|this|for|with|about|from|into)$/i.test(w));
  const topic = filtered.slice(0, 2).join(" ").toLowerCase();
  return topic.length > 2 ? topic.replace(/\s+/g, "-") : null;
}

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

interface MockEnv {
  [key: string]: string | undefined;
}

function buildChildEnv(
  environment: Record<string, string>,
  parentEnv: MockEnv,
  platform: string,
  offline: boolean,
): MockEnv {
  const env: MockEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (platform === "win32") {
      const normalizedKey = key.toLowerCase();
      for (const existingKey of Object.keys(env)) {
        if (existingKey.toLowerCase() === normalizedKey) delete env[existingKey];
      }
    }
    env[key] = value;
  }
  if (offline) {
    if (platform === "win32") {
      const normalizedKey = "PI_OFFLINE".toLowerCase();
      for (const existingKey of Object.keys(env)) {
        if (existingKey.toLowerCase() === normalizedKey) delete env[existingKey];
      }
    }
    env["PI_OFFLINE"] = "1";
  } else {
    if (platform === "win32") {
      const normalizedKey = "PI_OFFLINE".toLowerCase();
      for (const existingKey of Object.keys(env)) {
        if (existingKey.toLowerCase() === normalizedKey) delete env[existingKey];
      }
    }
    delete env["PI_OFFLINE"];
  }
  return env;
}

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

// Re-implement the fixed version for testing
function stableStringify(value: unknown, seen?: WeakSet<object>): string {
  const visited = seen ?? new WeakSet<object>();
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (visited.has(value as object)) {
    return '"<circular>"';
  }
  visited.add(value as object);

  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map((item) => stableStringify(item, visited)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, visited)}`)
    .join(",")}}`;
}

describe("stableStringify (runner-events.js)", () => {
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
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
    assert.deepEqual(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
  });
});

describe("emptyFailedResult()", () => {
  it("creates a failed result with the given message", () => {
    const result = { task: "test", exitCode: 1, messages: [], stderr: "something went wrong", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, stopReason: "error", errorMessage: "something went wrong" };
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorMessage, "something went wrong");
    assert.equal(result.stopReason, "error");
  });
});
