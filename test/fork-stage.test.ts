/**
 * Tests for fork-stage helpers: redaction, session sanitization, buildPiArgs, appendTaskToSessionJsonl.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sanitizeSessionJsonl,
  buildPiArgs,
  estimateCommandLineLength,
  appendTaskToSessionJsonl,
} from "../src/fork-stage.js";
import { PROMPT_VERSION } from "../src/prompt-version.js";
import type { StageProfile } from "../src/types.js";

const stageProfile: StageProfile = { provider: "openai", id: "gpt-5-mini", thinking: "minimal" };

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

describe("sanitizeSessionJsonl", () => {
  it("redacts an OpenAI API key in assistant content", () => {
    const jsonl = line({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "key is sk-abc123xyz78900000000000000000000" }],
    });
    const result = sanitizeSessionJsonl(jsonl);
    assert.ok(result.jsonl.includes("[REDACTED_API_KEY]"));
    assert.ok(!result.jsonl.includes("sk-abc123xyz78900000000000000000000"));
    assert.strictEqual(result.stripped, 0);
  });

  it("redacts a hex secret", () => {
    const hex = "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const jsonl = line({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `secret: ${hex}` }],
    });
    const result = sanitizeSessionJsonl(jsonl);
    assert.ok(result.jsonl.includes("[REDACTED_HEX_KEY]"));
  });

  it("redacts a base64 secret", () => {
    const b64 = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB";
    const jsonl = line({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `token: ${b64}` }],
    });
    const result = sanitizeSessionJsonl(jsonl);
    assert.ok(result.jsonl.includes("[REDACTED_B64_KEY]"));
  });

  it("redacts --api-key in args", () => {
    const jsonl = line({
      type: "tool_use",
      toolName: "bash",
      args: { command: "pi --api-key sk-abc123xyz78900000000000000000000 do something" },
    });
    const result = sanitizeSessionJsonl(jsonl);
    assert.ok(result.jsonl.includes("--api-key [REDACTED]"));
    assert.ok(!result.jsonl.includes("sk-abc123xyz78900000000000000000000"));
  });

  it("redacts inside envelope messages", () => {
    const jsonl = line({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "use sk-abc123xyz78900000000000000000000" }],
      },
    });
    const result = sanitizeSessionJsonl(jsonl);
    assert.ok(result.jsonl.includes("[REDACTED_API_KEY]"));
  });

  it("strips system messages", () => {
    const jsonl = line({ type: "message", role: "system", content: [{ type: "text", text: "hi" }] });
    const result = sanitizeSessionJsonl(jsonl);
    assert.strictEqual(result.jsonl.trim(), "");
    assert.strictEqual(result.stripped, 1);
  });

  it("strips orphan tool results", () => {
    const jsonl = line({
      type: "message",
      role: "tool",
      tool_call_id: "missing",
      content: [{ type: "text", text: "result" }],
    });
    const result = sanitizeSessionJsonl(jsonl);
    assert.strictEqual(result.jsonl.trim(), "");
    assert.strictEqual(result.stripped, 1);
  });

  it("keeps tool results with matching assistant tool_calls", () => {
    const jsonl =
      line({
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "tc1", name: "read" }],
      }) +
      line({
        type: "message",
        role: "tool",
        tool_call_id: "tc1",
        content: [{ type: "text", text: "file content" }],
      });
    const result = sanitizeSessionJsonl(jsonl);
    assert.strictEqual(result.stripped, 0);
    assert.ok(result.jsonl.includes("file content"));
  });

  it("passes malformed JSON lines through unchanged", () => {
    const jsonl = "this is not json\n";
    const result = sanitizeSessionJsonl(jsonl);
    assert.strictEqual(result.jsonl.trim(), "this is not json");
    assert.strictEqual(result.stripped, 0);
  });

  it("counts combined system and orphan strips", () => {
    const jsonl =
      line({ type: "message", role: "system", content: [{ type: "text", text: "s" }] }) +
      line({ type: "message", role: "tool", tool_call_id: "orphan", content: [{ type: "text", text: "o" }] });
    const result = sanitizeSessionJsonl(jsonl);
    assert.strictEqual(result.stripped, 2);
  });
});

describe("buildPiArgs", () => {
  it("includes provider, model, thinking, session, and task", () => {
    const args = buildPiArgs("explore auth", "/tmp/session.jsonl", null, stageProfile, null);
    assert.ok(args.includes("--provider"));
    assert.ok(args.includes("openai"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gpt-5-mini"));
    assert.ok(args.includes("--thinking"));
    assert.ok(args.includes("minimal"));
    assert.ok(args.includes("--session"));
    assert.ok(args.includes("explore auth"));
  });

  it("disables extensions when extensions array is non-null", () => {
    const args = buildPiArgs("task", "/tmp/s.jsonl", [], stageProfile, null);
    assert.ok(args.includes("--no-extensions"));
  });

  it("forwards explicit extensions", () => {
    const args = buildPiArgs("task", "/tmp/s.jsonl", ["./ext.ts"], stageProfile, null);
    assert.ok(args.includes("--extension"));
    assert.ok(args.includes("./ext.ts"));
  });
});

describe("estimateCommandLineLength", () => {
  it("grows with argument length", () => {
    const short = estimateCommandLineLength("node", ["a"]);
    const long = estimateCommandLineLength("node", ["a".repeat(1000)]);
    assert.ok(long > short);
  });
});

describe("appendTaskToSessionJsonl", () => {
  it("appends system task instruction and user prompt", () => {
    const base = line({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] });
    const out = appendTaskToSessionJsonl(base, "explore auth");
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.strictEqual(lines[lines.length - 2].role, "system");
    assert.strictEqual(lines[lines.length - 2].name, "cdev-task");
    assert.strictEqual(lines[lines.length - 2].cdev_prompt_version, PROMPT_VERSION);
    assert.strictEqual(lines[lines.length - 1].role, "user");
  });
});
