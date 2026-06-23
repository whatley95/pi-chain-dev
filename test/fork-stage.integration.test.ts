/**
 * Integration tests for fork-stage child process failure modes.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStageCore, setPiSpawnResolver } from "../src/fork-stage.js";
import type { StageProfile } from "../src/types.js";

const stageProfile: StageProfile = { provider: "test", id: "test-model", thinking: "minimal" };

function makeOpts(cwd: string, overrides: Partial<Parameters<typeof runStageCore>[0]> = {}) {
  return {
    cwd,
    task: "test task",
    stageLabel: "test-stage",
    forkSessionJsonl: JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }) + "\n",
    stageProfile,
    extensions: null,
    environment: {},
    offline: true,
    ...overrides,
  };
}

function makeHelperScript(code: string): string {
  const path = join(tmpdir(), `cdev-helper-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(path, code, "utf-8");
  return path;
}

describe("runStageCore failure modes", () => {
  let cwd: string;
  let helpers: string[] = [];

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "cdev-fork-stage-"));
    helpers = [];
  });

  after(() => {
    setPiSpawnResolver(null);
    for (const h of helpers) {
      try { rmSync(h, { force: true }); } catch { /* ignore */ }
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function helper(code: string): { command: string; prefixArgs: string[] } {
    const path = makeHelperScript(code);
    helpers.push(path);
    return { command: process.execPath, prefixArgs: [path] };
  }

  it("handles spawn failure (missing binary)", async () => {
    setPiSpawnResolver(() => ({ command: "/nonexistent/pi/binary-xyz", prefixArgs: [] }));
    const result = await runStageCore(makeOpts(cwd));
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.length > 0, "expected stderr on spawn failure");
  });

  it("handles non-zero exit code", async () => {
    setPiSpawnResolver(() => helper("process.stderr.write('scout failed\\n'); process.exit(1);"));
    const result = await runStageCore(makeOpts(cwd));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /scout failed/);
  });

  it("handles malformed stdout JSON gracefully", async () => {
    setPiSpawnResolver(() => helper("process.stdout.write('this is not json\\n'); process.exit(0);"));
    const result = await runStageCore(makeOpts(cwd));
    assert.equal(result.exitCode, 0);
    assert.equal(result.messages.length, 0);
  });

  it("handles valid stdout JSON", async () => {
    const event = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    });
    setPiSpawnResolver(() => helper(`process.stdout.write(${JSON.stringify(event)} + '\\n'); process.exit(0);`),
    );
    const result = await runStageCore(makeOpts(cwd));
    assert.equal(result.exitCode, 0);
    assert.ok(result.messages.length > 0);
  });

  it("times out a hung process", async () => {
    setPiSpawnResolver(() => helper("setTimeout(() => {}, 30000);"));
    const result = await runStageCore(makeOpts(cwd, { stageTimeoutMs: 100 }));
    assert.match(result.stderr, /timed out/);
  });

  it("aborts a process via AbortSignal", async () => {
    setPiSpawnResolver(() => helper("setTimeout(() => {}, 30000);"));
    const controller = new AbortController();
    const promise = runStageCore(makeOpts(cwd, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    // Exit code may be 0 if the process was killed before settle, or non-zero.
    // The important thing is it returns without hanging.
    assert.ok(typeof result.exitCode === "number");
  });
});
