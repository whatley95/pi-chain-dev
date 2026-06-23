/**
 * Tests for the structured logger.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initLogger,
  getMinLogLevel,
  logDebug,
  logInfo,
  logWarn,
  logError,
  getErrorCount,
  clearErrorLog,
  debugLogPath,
  errorLogPath,
} from "../src/logger.js";

describe("logger", () => {
  let cwd: string;
  let originalLevel = getMinLogLevel();

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "cdev-logger-"));
    originalLevel = getMinLogLevel();
    initLogger({ level: "debug", debug: true });
  });

  after(() => {
    initLogger({ level: originalLevel, debug: false });
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function readDebugLog(): string[] {
    const path = debugLogPath(cwd);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
  }

  it("writes debug records to debug.log", () => {
    logDebug(cwd, "test", "hello debug");
    const lines = readDebugLog();
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.level, "debug");
    assert.equal(record.context, "test");
    assert.equal(record.message, "hello debug");
    assert.ok(record.ts);
  });

  it("writes info, warn, and error records", () => {
    logInfo(cwd, "test-info", "hello info");
    logWarn(cwd, "test-warn", "hello warn");
    logError(cwd, "test-error", new Error("boom"));
    const lines = readDebugLog();
    const last = lines.slice(-3).map((l) => JSON.parse(l));
    assert.deepEqual(
      last.map((r) => r.level),
      ["info", "warn", "error"],
    );
    assert.equal(last[2].message, "boom");
    assert.ok(last[2].stack);
  });

  it("mirrors errors to errors.jsonl", () => {
    clearErrorLog(cwd);
    logError(cwd, "mirror", new Error("reflected"));
    assert.equal(getErrorCount(cwd), 1);
    const raw = readFileSync(errorLogPath(cwd), "utf-8").trim();
    const record = JSON.parse(raw);
    assert.equal(record.context, "mirror");
    assert.equal(record.message, "reflected");
  });

  it("clears the error log", () => {
    logError(cwd, "to-clear", new Error("x"));
    assert.ok(getErrorCount(cwd) >= 1);
    clearErrorLog(cwd);
    assert.equal(getErrorCount(cwd), 0);
  });

  it("does not crash when logging to a read-only directory", async () => {
    const roDir = mkdtempSync(join(tmpdir(), "cdev-logger-ro-"));
    // Make directory read-only on POSIX; on Windows this is a no-op for this test
    if (process.platform !== "win32") {
      rmSync(roDir, { recursive: true, force: true });
      const fresh = mkdtempSync(join(tmpdir(), "cdev-logger-ro-"));
      const { chmodSync } = await import("node:fs");
      try {
        chmodSync(fresh, 0o555);
        assert.doesNotThrow(() => logError(fresh, "readonly", new Error("fail")));
      } finally {
        chmodSync(fresh, 0o755);
        rmSync(fresh, { recursive: true, force: true });
      }
    } else {
      // On Windows just verify logging does not throw in an existing dir
      assert.doesNotThrow(() => logError(roDir, "readonly", new Error("fail")));
      rmSync(roDir, { recursive: true, force: true });
    }
  });
});
