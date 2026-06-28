/**
 * Tests for fork-orchestrator validation helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateStage1Findings, shouldReExplore, countLowConfidenceFindings } from "../src/fork-orchestrator.js";
import type { Stage1Findings } from "../src/types.js";

describe("countLowConfidenceFindings", () => {
  it("returns 0 for empty findings", () => {
    const f: Stage1Findings = { findings: [], files: [], commands: [] };
    assert.equal(countLowConfidenceFindings(f), 0);
  });

  it("counts low confidence findings", () => {
    const f: Stage1Findings = {
      findings: [
        { observation: "a", confidence: "high", evidence: "x", file: "x.ts" },
        { observation: "b", confidence: "low", evidence: "y", file: "y.ts" },
        { observation: "c", confidence: "medium", evidence: "z", file: "z.ts" },
        { observation: "d", confidence: "low", evidence: "w", file: "w.ts" },
      ],
      files: [],
      commands: [],
    };
    assert.equal(countLowConfidenceFindings(f), 2);
  });
});

describe("validateStage1Findings", () => {
  it("returns valid for well-formed findings with summary", () => {
    const f: Stage1Findings = {
      summary: "Found important patterns in the codebase.",
      findings: [{ observation: "x uses zod for validation", confidence: "high", evidence: "seen in schema.ts", file: "schema.ts" }],
      files: ["schema.ts"],
      commands: ["grep"],
    };
    const result = validateStage1Findings(f, "test");
    assert.equal(result.valid, true);
  });

  it("flags empty findings", () => {
    const f: Stage1Findings = { summary: "Nothing found.", findings: [], files: [], commands: [] };
    const result = validateStage1Findings(f, "test");
    assert.equal(result.valid, false);
    if (!result.valid) assert.ok(result.reason);
  });

  it("flags all-low-confidence findings", () => {
    const f: Stage1Findings = {
      summary: "All findings are speculative.",
      findings: [
        { observation: "maybe x", confidence: "low", evidence: "guess", file: "a.ts" },
        { observation: "maybe y", confidence: "low", evidence: "hunch", file: "b.ts" },
      ],
      files: [],
      commands: [],
    };
    const result = validateStage1Findings(f, "test");
    assert.equal(result.valid, false);
  });
});

describe("shouldReExplore", () => {
  it("should re-explore when fewer than 3 findings and not verify", () => {
    const f: Stage1Findings = {
      summary: "Two findings.",
      findings: [
        { observation: "x", confidence: "high", evidence: "e", file: "f.ts" },
        { observation: "y", confidence: "high", evidence: "e", file: "g.ts" },
      ],
      files: [],
      commands: [],
    };
    const result = shouldReExplore(f, false);
    assert.equal(result.should, true);
  });

  it("should not re-explore with 3+ findings and verify false", () => {
    const f: Stage1Findings = {
      summary: "Three findings.",
      findings: [
        { observation: "x", confidence: "high", evidence: "e", file: "f.ts" },
        { observation: "y", confidence: "high", evidence: "e", file: "g.ts" },
        { observation: "z", confidence: "high", evidence: "e", file: "h.ts" },
      ],
      files: [],
      commands: [],
    };
    const result = shouldReExplore(f, false);
    assert.equal(result.should, false);
  });

  it("should re-explore when findings is null", () => {
    const result = shouldReExplore(null, true);
    assert.equal(result.should, true);
  });
});
