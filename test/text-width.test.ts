/**
 * Tests for text-width utilities.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapText, safeDisplayText } from "../src/text-width.js";

describe("wrapText", () => {
  it("returns empty/undefined text unchanged", () => {
    assert.equal(wrapText(""), "");
  });

  it("leaves short lines unchanged", () => {
    const text = "short line\nanother short line";
    assert.equal(wrapText(text, 20), text);
  });

  it("wraps long lines at word boundaries", () => {
    const text = "one two three four five six seven eight nine ten";
    const wrapped = wrapText(text, 20);
    for (const line of wrapped.split("\n")) {
      assert.ok(line.length <= 20, `line exceeds width: ${line}`);
    }
    assert.match(wrapped, /one two three four/);
  });

  it("hard-wraps tokens longer than maxWidth", () => {
    const text = "a".repeat(200);
    const wrapped = wrapText(text, 50);
    for (const line of wrapped.split("\n")) {
      assert.ok(line.length <= 50, `line exceeds width: ${line.length}`);
    }
  });

  it("preserves existing newlines", () => {
    const text = "line1\nline2";
    assert.equal(wrapText(text, 10), text);
  });
});

describe("safeDisplayText", () => {
  it("wraps plain long text", () => {
    const text = "word ".repeat(50);
    const result = safeDisplayText(text, 30);
    for (const line of result.split("\n")) {
      assert.ok(line.length <= 30, `line exceeds width: ${line.length}`);
    }
  });

  it("pretty-prints and wraps JSON", () => {
    const text = JSON.stringify({ key: "value", long: "x".repeat(200) });
    const result = safeDisplayText(text, 50);
    assert.ok(result.includes('{\n  "key": "value"'));
    for (const line of result.split("\n")) {
      assert.ok(line.length <= 50, `line exceeds width: ${line.length}`);
    }
  });

  it("leaves short text unchanged", () => {
    const text = "short";
    assert.equal(safeDisplayText(text, 50), text);
  });
});
