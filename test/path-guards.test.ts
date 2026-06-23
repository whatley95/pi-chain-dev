/**
 * Tests for path guard helpers.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { isPathUnderCwd } from "../src/path-guards.js";

describe("isPathUnderCwd", () => {
  it("accepts a child path", () => {
    assert.strictEqual(isPathUnderCwd("/project", "/project/src/foo.ts"), true);
  });

  it("rejects a parent path", () => {
    assert.strictEqual(isPathUnderCwd("/project", "/etc/passwd"), false);
  });

  it("rejects a sibling path", () => {
    assert.strictEqual(isPathUnderCwd("/project", "/project2/file"), false);
  });

  it("rejects traversal that escapes", () => {
    assert.strictEqual(isPathUnderCwd("/project", "/project/../etc/passwd"), false);
  });

  it("rejects the cwd itself", () => {
    assert.strictEqual(isPathUnderCwd("/project", "/project"), false);
  });

  it("accepts a child path whose name starts with dot-dot", () => {
    assert.strictEqual(isPathUnderCwd("/project", "/project/..cache/file.txt"), true);
  });

  it("rejects cross-root paths on Windows", () => {
    const relative = path.win32.relative("C:\\project", "D:\\secret\\file.txt");
    assert.ok(path.win32.isAbsolute(relative), "test setup should produce a cross-drive absolute relative path");
    assert.strictEqual(isPathUnderCwd("C:\\project", "D:\\secret\\file.txt"), false);
  });
});
