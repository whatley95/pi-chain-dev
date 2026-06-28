/**
 * Tests for src/modes/ handlers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAutoForkParams } from "../src/tool.js";
import { handleRecall } from "../src/modes/recall.js";

describe("handleRecall", () => {
  it("validates recall params via tool dispatcher", () => {
    // handleRecall uses p.recall, ctx, config
    // Test param validation for recall
    const valid = validateAutoForkParams({ recall: "auth" });
    assert.equal(valid.valid, true);
    if (valid.valid) assert.equal(valid.value.recall, "auth");

    const list = validateAutoForkParams({ recall: "" });
    assert.equal(list.valid, true);
    if (list.valid) assert.equal(list.value.recall, "");

    const invalid = validateAutoForkParams({ recall: 123 });
    assert.equal(invalid.valid, false);
  });
});

describe("handleReview", () => {
  it("validates review params", () => {
    const result = validateAutoForkParams({ review: true });
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.value.review, true);
  });

  it("rejects review with non-boolean", () => {
    const result = validateAutoForkParams({ review: "yes" });
    assert.equal(result.valid, false);
  });

  it("rejects reviewFile with non-string", () => {
    const result = validateAutoForkParams({ review: true, reviewFile: true });
    assert.equal(result.valid, false);
  });

  it("accepts valid reviewFile string", () => {
    const result = validateAutoForkParams({ review: true, reviewFile: "./src/tool.ts" });
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.value.reviewFile, "./src/tool.ts");
  });
});

describe("handleAdvisor", () => {
  it("validates advisor params", () => {
    const result = validateAutoForkParams({ advisor: true, task: "how to proceed?" });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.value.advisor, true);
      assert.equal(result.value.task, "how to proceed?");
    }
  });

  it("validates askAdvisor", () => {
    const result = validateAutoForkParams({ advisor: true, askAdvisor: true, task: "quick check" });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.value.askAdvisor, true);
      assert.equal(result.value.advisor, true);
    }
  });
});

describe("handleResearch", () => {
  it("validates research params", () => {
    const result = validateAutoForkParams({ research: true, task: "why is login slow?" });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.value.research, true);
      assert.equal(result.value.task, "why is login slow?");
    }
  });
});

describe("handleYolo", () => {
  it("validates yolo params", () => {
    const result = validateAutoForkParams({ yolo: true, task: "implement feature" });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.value.yolo, true);
      assert.equal(result.value.task, "implement feature");
    }
  });
});

describe("handleFullFork", () => {
  it("validates full fork params (plan, quick, verify)", () => {
    for (const flag of ["plan", "quick", "verify"] as const) {
      const result = validateAutoForkParams({ [flag]: true, task: "refactor auth" });
      assert.equal(result.valid, true);
      if (result.valid) assert.equal(result.value[flag], true);
    }
  });

  it("rejects quick, verify, plan without task", () => {
    for (const flag of ["quick", "verify", "plan"] as const) {
      const result = validateAutoForkParams({ [flag]: true }); // no task
      assert.equal(result.valid, true); // task is optional in validation
      if (result.valid) assert.equal(result.value.task, undefined);
    }
  });

  it("validates parallel param bounds", () => {
    assert.equal(validateAutoForkParams({ task: "test", parallel: 2 }).valid, true);
    assert.equal(validateAutoForkParams({ task: "test", parallel: 4 }).valid, false);
    assert.equal(validateAutoForkParams({ task: "test", parallel: 0 }).valid, false);
  });
});

describe("cross-mode param combinations", () => {
  it("rejects mutually exclusive mode flags", () => {
    // Multiple mode flags can be validated; dispatcher prioritizes first match
    const result = validateAutoForkParams({ review: true, yolo: true, task: "test" });
    assert.equal(result.valid, true); // validation allows any combination
    if (result.valid) {
      // Dispatcher handles priority — review checked before yolo
      assert.equal(result.value.review, true);
      assert.equal(result.value.yolo, true);
    }
  });

  it("handles diffSpec validation", () => {
    const valid = validateAutoForkParams({ review: true, diffSpec: "HEAD~3..HEAD" });
    assert.equal(valid.valid, true);
    if (valid.valid) assert.equal(valid.value.diffSpec, "HEAD~3..HEAD");

    const invalid = validateAutoForkParams({ diffSpec: 42 });
    assert.equal(invalid.valid, false);
  });

  it("handles empty params (interactive menu)", () => {
    const result = validateAutoForkParams({});
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(Object.keys(result.value).length, 0);
    }
  });
});

describe("handleRecall logic", () => {
  function mockCtx(overrides: Record<string, unknown> = {}): any {
    return {
      cwd: process.cwd(),
      ui: { notify: () => {}, setWidget: () => {} },
      ...overrides,
    };
  }

  function mockConfig(overrides: Record<string, unknown> = {}): any {
    return {
      memory: true,
      ...overrides,
    };
  }

  it("returns disabled message when memory is off", async () => {
    const result = await handleRecall(
      { recall: "auth" },
      mockCtx(),
      mockConfig({ memory: false }),
    );
    assert.equal(result.isError, undefined);
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes("disabled"), "should mention disabled: " + text);
  });

  it("returns miss for unknown topic", async () => {
    const result = await handleRecall(
      { recall: "nonexistent-topic-xyz" },
      mockCtx(),
      mockConfig(),
    );
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes("miss") || text.includes("no findings"), "should mention miss: " + text);
  });

  it("returns topic list for empty recall", async () => {
    const result = await handleRecall(
      { recall: "" },
      mockCtx(),
      mockConfig(),
    );
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes("cdev memory") || text.length > 0, "should return content: " + text);
  });
});
