/**
 * Tests for prompt builders.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStage1Prompt,
  buildStage2Prompt,
  buildReviewPrompt,
  buildFileReviewPrompt,
  buildDiffReviewPrompt,
  buildYoloReviewSnapshot,
  buildYoloFixTask,
} from "../src/prompts.js";

describe("buildStage1Prompt", () => {
  it("includes the task and JSON schema", () => {
    const prompt = buildStage1Prompt("explore auth");
    assert.match(prompt, /explore auth/);
    assert.match(prompt, /"summary"/);
    assert.match(prompt, /"findings"/);
  });

  it("uses custom prompt when provided", () => {
    const prompt = buildStage1Prompt("explore auth", "CUSTOM INSTRUCTIONS");
    assert.match(prompt, /CUSTOM INSTRUCTIONS/);
  });

  it("omits audit guard in edit mode", () => {
    const editPrompt = buildStage1Prompt("fix bug", undefined, true);
    const normalPrompt = buildStage1Prompt("fix bug");
    assert.ok(!editPrompt.includes("AUDIT ONLY"));
    assert.ok(normalPrompt.includes("AUDIT ONLY"));
  });

  it("adds explicit read-only guard in quick mode", () => {
    const quickPrompt = buildStage1Prompt("explore auth", undefined, false, undefined, undefined, true);
    assert.match(quickPrompt, /QUICK EXPLORATION MODE/);
    assert.match(quickPrompt, /Read-only/);
    assert.match(quickPrompt, /gatherCodeContext/);
    assert.match(quickPrompt, /3-6 high-signal findings/);
  });

  it("does not include quick guard when quick is false", () => {
    const normalPrompt = buildStage1Prompt("explore auth");
    assert.ok(!normalPrompt.includes("QUICK MODE"));
  });

  it("forbids write operations via bash in all scout modes", () => {
    const prompt = buildStage1Prompt("explore auth");
    assert.ok(prompt.includes("READ-ONLY AUDIT MODE"));
    assert.ok(prompt.includes("Never use `bash` to write"));
    assert.ok(prompt.includes("`echo >`"));
    assert.ok(prompt.includes("`cat >`"));
    assert.ok(prompt.includes("`cp`"));
    assert.ok(prompt.includes("`rm`"));
    assert.ok(prompt.includes("`mkdir`"));
  });
});

describe("buildStage2Prompt", () => {
  it("includes previous findings", () => {
    const prompt = buildStage2Prompt("synthesize", "findings text");
    assert.match(prompt, /findings text/);
    assert.match(prompt, /groundingScore/);
  });
});

describe("buildReviewPrompt", () => {
  it("includes default review instructions", () => {
    const prompt = buildReviewPrompt();
    assert.match(prompt, /Review the code changes/);
    assert.ok(prompt.includes("AUDIT ONLY"));
  });

  it("uses custom prompt when provided", () => {
    const prompt = buildReviewPrompt("CUSTOM REVIEW");
    assert.match(prompt, /CUSTOM REVIEW/);
  });
});

describe("buildFileReviewPrompt", () => {
  it("includes file path and referenced files", () => {
    const prompt = buildFileReviewPrompt("src/foo.ts", "content", { "src/bar.ts": "bar content" });
    assert.match(prompt, /src\/foo\.ts/);
    assert.match(prompt, /bar content/);
  });

  it("truncates very long report content", () => {
    const long = "x".repeat(200_000);
    const prompt = buildFileReviewPrompt("src/foo.ts", long, {});
    assert.ok(prompt.length < long.length + 1000);
  });
});

describe("buildDiffReviewPrompt", () => {
  it("includes diff spec and content", () => {
    const prompt = buildDiffReviewPrompt("main...feature", "+added line");
    assert.match(prompt, /main\.\.\.feature/);
    assert.match(prompt, /\+added line/);
  });
});

describe("buildYoloReviewSnapshot", () => {
  it("includes report content and round number", () => {
    const snapshot = JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }) + "\n";
    const out = buildYoloReviewSnapshot(snapshot, "report content", 2);
    assert.match(out, /YOLO review-fix round 2/);
    assert.match(out, /report content/);
  });
});

describe("buildYoloFixTask", () => {
  it("includes review comments and original task", () => {
    const prompt = buildYoloFixTask("original task", "needs more tests", 1);
    assert.match(prompt, /needs more tests/);
    assert.match(prompt, /original task/);
  });
});
