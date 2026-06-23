/**
 * Tests for budget/cost helpers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkCostBudget,
  estimateForkCost,
  checkSessionCostAlert,
  formatCost,
  recordForkCost,
  resetSessionForkCost,
} from "../src/extension-context.js";
import type { AutoForkConfig, StageProfile } from "../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage1: StageProfile = { provider: "openai", id: "gpt-5-mini", thinking: "minimal" };
const stage2: StageProfile = { provider: "opencode", id: "deepseek-v4-flash", thinking: "xhigh" };

function config(overrides: Partial<AutoForkConfig> = {}): AutoForkConfig {
  return {
    stage1,
    stage2,
    extensions: null,
    environment: {},
    offline: true,
    costFooter: true,
    auto: false,
    promptsEnabled: true,
    memory: true,
    themed: false,
    autoVerify: true,
    maxForkCost: 0,
    maxSessionCost: 0,
    yolo: { enabled: false, maxRounds: 3, stopOnPass: true, autoApply: "manual" },
    ...overrides,
  };
}

describe("formatCost", () => {
  it("formats dollars", () => {
    assert.strictEqual(formatCost(1.2345), "$1.2345");
  });
});

describe("checkCostBudget", () => {
  it("allows when no limits are set", () => {
    const result = checkCostBudget(config(), "/tmp", 10);
    assert.strictEqual(result.allowed, true);
  });

  it("blocks fork cost exceeding maxForkCost", () => {
    const result = checkCostBudget(config({ maxForkCost: 1 }), "/tmp", 2);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason!, /exceeds maxForkCost/);
  });

  it("blocks session cost that would exceed maxSessionCost", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-budget-"));
    resetSessionForkCost(cwd);
    recordForkCost(cwd, 4);
    const result = checkCostBudget(config({ maxSessionCost: 5 }), cwd, 2);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason!, /exceeding maxSessionCost/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("allows session cost within budget", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-budget-"));
    resetSessionForkCost(cwd);
    recordForkCost(cwd, 1);
    const result = checkCostBudget(config({ maxSessionCost: 5 }), cwd, 2);
    assert.strictEqual(result.allowed, true);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("estimateForkCost", () => {
  it("returns zero when prices are unknown", () => {
    const unknownStage: StageProfile = { provider: "x", id: "unknown-model", thinking: "minimal" };
    const estimate = estimateForkCost({ task: "x", stage1Profile: unknownStage, stage2Profile: unknownStage });
    assert.strictEqual(estimate.cost, 0);
  });

  it("doubles stage1 cost in verify mode", () => {
    const base = estimateForkCost({ task: "explore auth", stage1Profile: stage1, stage2Profile: stage2, verify: false });
    const verified = estimateForkCost({ task: "explore auth", stage1Profile: stage1, stage2Profile: stage2, verify: true });
    assert.ok(verified.cost > base.cost);
  });

  it("skips stage2 cost in quick mode", () => {
    const full = estimateForkCost({ task: "x", stage1Profile: stage1, stage2Profile: stage2 });
    const quick = estimateForkCost({ task: "x", stage1Profile: stage1, stage2Profile: stage2, quick: true });
    assert.ok(quick.cost < full.cost);
  });
});

describe("checkSessionCostAlert", () => {
  it("returns null when maxSessionCost is zero", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-alert-"));
    resetSessionForkCost(cwd);
    assert.strictEqual(checkSessionCostAlert(config(), cwd), null);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns warning at 80% of budget", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-alert-"));
    resetSessionForkCost(cwd);
    recordForkCost(cwd, 8);
    const alert = checkSessionCostAlert(config({ maxSessionCost: 10 }), cwd);
    assert.ok(alert);
    assert.strictEqual(alert!.level, "warning");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns critical at 95% of budget", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-alert-"));
    resetSessionForkCost(cwd);
    recordForkCost(cwd, 9.6);
    const alert = checkSessionCostAlert(config({ maxSessionCost: 10 }), cwd);
    assert.ok(alert);
    assert.strictEqual(alert!.level, "critical");
    rmSync(cwd, { recursive: true, force: true });
  });
});
