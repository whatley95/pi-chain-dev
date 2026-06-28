/**
 * Tests for config merge logic: normalizeYoloConfig, normalizeConfidenceGates,
 * evaluateConfidenceGates, and config deep-merge behavior.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeYoloConfig,
  normalizeConfidenceGates,
  evaluateConfidenceGates,
} from "../src/types.js";
import type { Stage1Findings, StageProfile } from "../src/types.js";

// ── normalizeYoloConfig ──────────────────────────────────

describe("normalizeYoloConfig", () => {
  it("uses defaults when config is undefined", () => {
    const result = normalizeYoloConfig();
    assert.equal(result.enabled, false);
    assert.equal(result.maxRounds, 3);
    assert.equal(result.stopOnPass, true);
    assert.equal(result.autoApply, "manual");
    assert.equal(result.reviewProfile, undefined);
    assert.equal(result.fixProfile, undefined);
  });

  it("uses defaults when config is empty", () => {
    const result = normalizeYoloConfig({});
    assert.equal(result.enabled, false);
    assert.equal(result.maxRounds, 3);
    assert.equal(result.stopOnPass, true);
    assert.equal(result.autoApply, "manual");
  });

  it("clamps maxRounds to 7", () => {
    const result = normalizeYoloConfig({ maxRounds: 100 });
    assert.equal(result.maxRounds, 7);
  });

  it("clamps maxRounds to at least 1", () => {
    const result = normalizeYoloConfig({ maxRounds: 0 });
    assert.equal(result.maxRounds, 1);
  });

  it("preserves configured values", () => {
    const profile: StageProfile = { provider: "test", id: "model", thinking: "high" };
    const result = normalizeYoloConfig({
      enabled: true,
      maxRounds: 5,
      stopOnPass: false,
      autoApply: "propose",
      reviewProfile: profile,
      fixProfile: profile,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.maxRounds, 5);
    assert.equal(result.stopOnPass, false);
    assert.equal(result.autoApply, "propose");
    assert.deepEqual(result.reviewProfile, profile);
    assert.deepEqual(result.fixProfile, profile);
  });

  it("accepts autoApply: 'auto'", () => {
    const result = normalizeYoloConfig({ autoApply: "auto" });
    assert.equal(result.autoApply, "auto");
  });
});

// ── formatYoloStatus ─────────────────────────────────────

import { formatYoloStatus } from "../src/types.js";

describe("formatYoloStatus", () => {
  it("returns OFF when disabled", () => {
    assert.equal(formatYoloStatus({ enabled: false }), "OFF");
  });

  it("returns formatted status when enabled", () => {
    const status = formatYoloStatus({ enabled: true, maxRounds: 3, autoApply: "manual" });
    assert.ok(status.includes("ON"));
    assert.ok(status.includes("3 rounds"));
    assert.ok(status.includes("manual"));
  });
});

// ── normalizeConfidenceGates ─────────────────────────────

describe("normalizeConfidenceGates", () => {
  it("uses defaults when config is undefined", () => {
    const result = normalizeConfidenceGates();
    assert.equal(result.minFindings, 3);
    assert.equal(result.maxLowConfidenceRatio, 0.5);
    assert.equal(result.minFileAnchors, 1);
    assert.equal(result.minCommandEvidence, 1);
    assert.equal(result.autoReExplore, true);
  });

  it("clamps minFindings to non-negative", () => {
    assert.equal(normalizeConfidenceGates({ minFindings: -5 }).minFindings, 0);
  });

  it("clamps maxLowConfidenceRatio to [0, 1]", () => {
    assert.equal(normalizeConfidenceGates({ maxLowConfidenceRatio: 5 }).maxLowConfidenceRatio, 1);
    assert.equal(normalizeConfidenceGates({ maxLowConfidenceRatio: -1 }).maxLowConfidenceRatio, 0);
  });

  it("preserves partial overrides", () => {
    const result = normalizeConfidenceGates({ minFindings: 5 });
    assert.equal(result.minFindings, 5);
    assert.equal(result.maxLowConfidenceRatio, 0.5); // default
    assert.equal(result.minFileAnchors, 1);           // default
    assert.equal(result.autoReExplore, true);          // default
  });
});

// ── evaluateConfidenceGates ──────────────────────────────

const makeFindings = (overrides?: Partial<Stage1Findings>): Stage1Findings => ({
  summary: "test findings",
  findings: [
    { observation: "bug in auth", confidence: "high", file: "src/auth.ts", evidence: "`grep -r` found" },
    { observation: "slow query", confidence: "medium", file: "src/db.ts", evidence: "output shows 5s" },
    { observation: "missing test", confidence: "high", file: "src/auth.test.ts" },
  ],
  ...overrides,
});

describe("evaluateConfidenceGates", () => {
  it("passes with good findings", () => {
    const result = evaluateConfidenceGates(makeFindings());
    assert.equal(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("fails when too few findings", () => {
    const result = evaluateConfidenceGates(makeFindings({ findings: [] }));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some(r => r.includes("finding")));
  });

  it("fails when too many low-confidence findings", () => {
    const result = evaluateConfidenceGates(makeFindings({
      findings: [
        { observation: "maybe bug", confidence: "low" },
        { observation: "maybe perf", confidence: "low" },
        { observation: "maybe style", confidence: "low" },
      ],
    }));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some(r => r.includes("low confidence")));
  });

  it("fails when no file anchors", () => {
    const result = evaluateConfidenceGates(makeFindings({
      findings: [
        { observation: "general thought", confidence: "high" },
        { observation: "another thought", confidence: "high" },
        { observation: "third thought", confidence: "high" },
      ],
    }));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some(r => r.includes("file anchor")));
  });

  it("fails when no command evidence", () => {
    const result = evaluateConfidenceGates(makeFindings({
      findings: [
        { observation: "bug in auth", confidence: "high", file: "src/auth.ts" },
        { observation: "slow query", confidence: "high", file: "src/db.ts" },
        { observation: "missing test", confidence: "high", file: "src/auth.test.ts" },
      ],
    }));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some(r => r.includes("command evidence")));
  });

  it("passes with custom generous gates", () => {
    const result = evaluateConfidenceGates(
      makeFindings({ findings: [{ observation: "only one", confidence: "low" }] }),
      { minFindings: 0, maxLowConfidenceRatio: 1, minFileAnchors: 0, minCommandEvidence: 0 },
    );
    assert.equal(result.passed, true);
  });
});
