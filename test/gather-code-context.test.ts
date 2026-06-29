import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  formatGatherCodeContextResult,
  gatherCodeContext,
} from "../src/gather-code-context.js";

describe("gatherCodeContext", () => {
  it("returns ranked snippets for matching files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-gather-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(
        join(cwd, "src", "alpha.ts"),
        [
          "export function alpha() {",
          "  return buildStage1Prompt('x');",
          "}",
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        join(cwd, "src", "beta.ts"),
        [
          "export const beta = 1;",
          "export const gamma = 2;",
        ].join("\n"),
        "utf-8",
      );

      const result = gatherCodeContext(cwd, {
        query: "buildStage1Prompt",
        paths: ["src"],
        maxFiles: 5,
        contextLines: 1,
      });
      const text = formatGatherCodeContextResult(result);

      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].file, "src/alpha.ts");
      assert.match(text, /src[/\\]alpha\.ts:1-3|src\/alpha\.ts:1-3/);
      assert.match(text, /2: {3}return buildStage1Prompt/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects search paths outside the workspace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdev-gather-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "local.ts"), "const local = true;\n", "utf-8");

      const result = gatherCodeContext(cwd, {
        query: "local",
        paths: ["..", "src"],
      });

      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].file, "src/local.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
