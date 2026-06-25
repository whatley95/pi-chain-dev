import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReportFile, sanitizeReportFileName } from "../src/report.js";

describe("report.ts", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cdev-report-test-"));
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("sanitizes report file names", () => {
    assert.strictEqual(sanitizeReportFileName("../../etc/passwd"), "passwd");
    assert.strictEqual(sanitizeReportFileName("hello world.md"), "hello-world.md");
    assert.strictEqual(sanitizeReportFileName(".hidden"), "-hidden");
  });

  it("writes a research report and returns the relative path", () => {
    const { reportRelPath, written } = writeReportFile({
      cwd,
      fileName: "research-test.md",
      title: "Research: test",
      reviewer: "gpt-5-mini",
      body: "Found the issue in `src/auth.ts`.",
    });

    assert.strictEqual(written, true);
    assert.match(reportRelPath, /^\.pi\/cdev\/reports\/research-test\.md$/);

    const fullPath = join(cwd, reportRelPath);
    assert.ok(existsSync(fullPath));
    const content = readFileSync(fullPath, "utf-8");
    assert.ok(content.includes("# Research: test"));
    assert.ok(content.includes("Found the issue in"));
    assert.ok(content.includes("Reviewer:** gpt-5-mini"));
  });

  it("writes a report without reviewer", () => {
    const { reportRelPath, written } = writeReportFile({
      cwd,
      fileName: "plan-test.md",
      title: "cdev plan",
      body: "Plan body here",
    });

    assert.strictEqual(written, true);
    const fullPath = join(cwd, reportRelPath);
    const content = readFileSync(fullPath, "utf-8");
    assert.ok(content.includes("# cdev plan"));
    assert.ok(!content.includes("Reviewer:"));
  });

  it("strips internal reasoning markers from report body", () => {
    const body = `Before analysis.
<thinking>
I need to check the cache key logic step by step.
</thinking>
After analysis.`;
    const { reportRelPath } = writeReportFile({
      cwd,
      fileName: "reasoning-test.md",
      title: "Reasoning Test",
      body,
    });
    const fullPath = join(cwd, reportRelPath);
    const content = readFileSync(fullPath, "utf-8");
    assert.ok(content.includes("Before analysis."));
    assert.ok(content.includes("After analysis."));
    assert.ok(!content.includes("I need to check the cache key logic"));
    assert.ok(!content.includes("<thinking>"));
  });
});
