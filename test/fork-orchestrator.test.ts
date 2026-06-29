/**
 * Tests for fork-orchestrator helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeStage1Findings } from "../src/fork-orchestrator.js";
import type { Stage1Findings } from "../src/types.js";

describe("mergeStage1Findings", () => {
  it("merges unique findings from two runs", () => {
    const a: Stage1Findings = {
      summary: "run A",
      findings: [{ observation: "JWT used", confidence: "high", file: "auth.ts" }],
      deadEnds: ["oauth1"],
    };
    const b: Stage1Findings = {
      summary: "run B",
      findings: [{ observation: "sessions stored in redis", confidence: "medium" }],
      assumptions: ["redis is persistent"],
    };
    const merged = mergeStage1Findings(a, b);
    assert.equal(merged.findings.length, 2);
    assert.equal(merged.deadEnds!.length, 1);
    assert.equal(merged.assumptions!.length, 1);
  });

  it("deduplicates near-duplicate findings", () => {
    const a: Stage1Findings = {
      summary: "run A",
      findings: [{ observation: "JWT used for authentication", confidence: "high" }],
    };
    const b: Stage1Findings = {
      summary: "run B",
      findings: [{ observation: "JWT used for authentication", confidence: "medium" }],
    };
    const merged = mergeStage1Findings(a, b);
    assert.equal(merged.findings.length, 1);
  });
});
