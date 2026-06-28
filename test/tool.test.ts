/**
 * Tests for tool.ts: validateAutoForkParams and basic dispatching.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAutoForkParams } from "../src/tool.js";

describe("validateAutoForkParams", () => {
  it("rejects non-string task", () => {
    const result = validateAutoForkParams({ task: 123 });
    assert.equal(result.valid, false);
    if (!result.valid) assert.ok(result.error.includes("task must be a string"));
  });

  it("accepts valid task string", () => {
    const result = validateAutoForkParams({ task: "explore the codebase" });
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.value.task, "explore the codebase");
  });

  it("rejects non-boolean review flag", () => {
    const result = validateAutoForkParams({ review: "yes" });
    assert.equal(result.valid, false);
  });

  it("accepts boolean flags", () => {
    const result = validateAutoForkParams({ quick: true });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.value.quick, true);
          }
  });

  it("rejects parallel out of range", () => {
    assert.equal(validateAutoForkParams({ parallel: 0 }).valid, false);
    assert.equal(validateAutoForkParams({ parallel: 4 }).valid, false);
    assert.equal(validateAutoForkParams({ parallel: -1 }).valid, false);
  });

  it("accepts valid parallel values", () => {
    assert.equal(validateAutoForkParams({ parallel: 1 }).valid, true);
    assert.equal(validateAutoForkParams({ parallel: 2 }).valid, true);
    assert.equal(validateAutoForkParams({ parallel: 3 }).valid, true);
  });

  it("accepts recall and reviewFile as strings", () => {
    const result = validateAutoForkParams({ recall: "topic1", reviewFile: "./file.ts" });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.value.recall, "topic1");
      assert.equal(result.value.reviewFile, "./file.ts");
    }
  });

  it("rejects non-string reviewFile", () => {
    const result = validateAutoForkParams({ reviewFile: true });
    assert.equal(result.valid, false);
  });

  it("accumulates multiple errors", () => {
    const result = validateAutoForkParams({ task: 42, review: "nope", parallel: 5 });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.error.includes("task"));
      assert.ok(result.error.includes("review"));
      assert.ok(result.error.includes("parallel"));
    }
  });
});
