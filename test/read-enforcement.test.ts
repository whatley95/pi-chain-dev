import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldBlockRead, shouldBlockGrep, getPreferCdevReadRule } from "../src/read-enforcement.js";

describe("read-enforcement", () => {
  describe("shouldBlockRead", () => {
    it("blocks source files", () => {
      assert.ok(shouldBlockRead("src/index.ts"));
      assert.ok(shouldBlockRead("lib/foo.py"));
      assert.ok(shouldBlockRead("config.yaml"));
    });

    it("blocks extension-less project files", () => {
      assert.ok(shouldBlockRead("Makefile"));
      assert.ok(shouldBlockRead("Dockerfile"));
    });

    it("does not block README-style docs", () => {
      assert.equal(shouldBlockRead("README.md"), undefined);
      assert.equal(shouldBlockRead("AGENTS.md"), undefined);
      assert.equal(shouldBlockRead("LICENSE"), undefined);
    });

    it("does not block image/binary files", () => {
      assert.equal(shouldBlockRead("screenshot.png"), undefined);
      assert.equal(shouldBlockRead("archive.zip"), undefined);
      assert.equal(shouldBlockRead("document.pdf"), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockRead("src/foo.ts");
      assert.ok(result);
      assert.ok(result!.reason.includes("/cdev read src/foo.ts"));
      assert.ok(result!.reason.includes('cdev({ quick:true, task: "read src/foo.ts" })'));
    });
  });

  describe("getPreferCdevReadRule", () => {
    it("returns a non-empty rule with the injection marker", () => {
      const rule = getPreferCdevReadRule();
      assert.ok(rule.length > 0);
      assert.ok(rule.includes("pi-chain-dev:enforce-cdev-tools"));
      assert.ok(rule.includes("/cdev read"));
    });
  });

  describe("shouldBlockGrep", () => {
    it("blocks grep on source paths", () => {
      assert.ok(shouldBlockGrep("function", "src"));
      assert.ok(shouldBlockGrep("TODO", "src/**/*.ts"));
      assert.ok(shouldBlockGrep("export", "lib", "*.ts"));
    });

    it("blocks grep with no scope", () => {
      assert.ok(shouldBlockGrep("foo", ""));
    });

    it("does not block grep outside the project", () => {
      assert.equal(shouldBlockGrep("foo", "/etc"), undefined);
      assert.equal(shouldBlockGrep("foo", "~/.config"), undefined);
    });

    it("does not block grep in excluded directories", () => {
      assert.equal(shouldBlockGrep("foo", "node_modules/bar"), undefined);
      assert.equal(shouldBlockGrep("foo", ".git/hooks"), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockGrep("TODO", "src");
      assert.ok(result);
      assert.ok(result!.reason.includes("search for 'TODO' in src"));
      assert.ok(result!.reason.includes("cdev({ quick:true"));
    });
  });
});
