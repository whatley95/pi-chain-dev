/**
 * Tests for config merge logic: normalizeYoloConfig and config deep-merge behavior.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeYoloConfig,
} from "../src/types.js";
import type { StageProfile } from "../src/types.js";

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

// ── evaluateConfidenceGates (deprecated no-op) ───────────


