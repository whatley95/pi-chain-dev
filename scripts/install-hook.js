#!/usr/bin/env node
/**
 * Installs the build-date pre-commit hook into .git/hooks/pre-commit.
 * Runs automatically via npm postinstall.
 */

import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const gitDir = join(repoRoot, ".git");
const hooksDir = join(gitDir, "hooks");
const source = join(__dirname, "update-build-date.js");
const target = join(hooksDir, "pre-commit");

if (!existsSync(gitDir)) {
  console.log("No .git directory found; skipping hook installation.");
  process.exit(0);
}

mkdirSync(hooksDir, { recursive: true });
copyFileSync(source, target);

if (process.platform !== "win32") {
  chmodSync(target, 0o755);
}

console.log("Installed build-date pre-commit hook.");
