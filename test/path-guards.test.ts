/**
 * Tests for path guard helpers.
 */

import assert from "node:assert/strict";
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
});
