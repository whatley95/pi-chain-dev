/**
 * Tests for json-extract helpers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractJsonFromText,
  parseJsonObject,
  parseStage1Findings,
  parseStage2Report,
  formatStage2Report,
} from "../src/json-extract.js";

const anyObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

describe("extractJsonFromText", () => {
  it("extracts bare JSON", () => {
    assert.strictEqual(extractJsonFromText('{"a":1}'), '{"a":1}');
  });

  it("extracts JSON inside markdown fence", () => {
    assert.strictEqual(extractJsonFromText('```json\n{"a":1}\n```'), '{"a":1}');
  });

  it("extracts the first balanced object from surrounding text", () => {
    assert.strictEqual(extractJsonFromText('some text {"a":1} more text'), '{"a":1}');
  });

  it("returns null when no object is found", () => {
    assert.strictEqual(extractJsonFromText("not json"), null);
  });
});

describe("parseJsonObject", () => {
  it("parses bare JSON", () => {
    const result = parseJsonObject('{"a":1}', anyObject);
    assert.deepEqual(result, { a: 1 });
  });

  it("parses JSON inside markdown fence", () => {
    const result = parseJsonObject('```json\n{"a":1}\n```', anyObject);
    assert.deepEqual(result, { a: 1 });
  });

  it("extracts the first balanced object from surrounding text", () => {
    const result = parseJsonObject('some text {"a":1} more text', anyObject);
    assert.deepEqual(result, { a: 1 });
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseJsonObject("not json", anyObject), null);
  });

  it("returns null when guard rejects", () => {
    const result = parseJsonObject('{"a":1}', (v): v is string => typeof v === "string");
    assert.strictEqual(result, null);
  });
});

describe("parseStage1Findings", () => {
  it("parses valid findings", () => {
    const text = JSON.stringify({
      summary: "summary",
      findings: [{ observation: "obs", confidence: "high" }],
    });
    const result = parseStage1Findings(text);
    assert.ok(result);
    assert.strictEqual(result!.summary, "summary");
  });

  it("rejects findings with invalid confidence", () => {
    const text = JSON.stringify({
      summary: "summary",
      findings: [{ observation: "obs", confidence: "maybe" }],
    });
    assert.strictEqual(parseStage1Findings(text), null);
  });

  it("rejects missing findings array", () => {
    const text = JSON.stringify({ summary: "summary" });
    assert.strictEqual(parseStage1Findings(text), null);
  });
});

describe("parseStage2Report", () => {
  it("parses a valid report", () => {
    const text = JSON.stringify({
      status: "ok",
      summary: "summary",
      output: "output",
      evidence: "evidence",
      learnings: "learnings",
      actionItems: ["task"],
      groundingScore: 0.9,
      ungroundedClaims: [],
    });
    const report = parseStage2Report(text);
    assert.ok(report);
    assert.strictEqual(report!.status, "ok");
  });

  it("rejects invalid status", () => {
    const text = JSON.stringify({
      status: "unknown",
      summary: "summary",
      output: "output",
      evidence: "evidence",
      learnings: "learnings",
      actionItems: ["task"],
    });
    assert.strictEqual(parseStage2Report(text), null);
  });
});

describe("formatStage2Report", () => {
  it("formats grounding score and claims", () => {
    const text = formatStage2Report({
      status: "ok",
      summary: "summary",
      output: "output",
      evidence: "evidence",
      learnings: "learnings",
      actionItems: ["task"],
      groundingScore: 0.8,
      ungroundedClaims: ["claim"],
    });
    assert.match(text, /80%/);
    assert.match(text, /claim/);
  });

  it("reports fully grounded when no ungrounded claims", () => {
    const text = formatStage2Report({
      status: "ok",
      summary: "summary",
      output: "output",
      evidence: "evidence",
      learnings: "learnings",
      actionItems: [],
      groundingScore: 1,
      ungroundedClaims: [],
    });
    assert.match(text, /All claims are grounded/);
  });
});
