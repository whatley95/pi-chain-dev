#!/usr/bin/env node
/**
 * Installs the build-date pre-commit hook into .git/hooks/pre-commit.
 *
 * Safe to run manually (`npm run setup-hook`) or as an npm script.
 * Refuses to overwrite an existing pre-commit hook unless --force is passed.
 */

const { copyFileSync, existsSync, mkdirSync, chmodSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = process.cwd();
const gitDir = join(repoRoot, ".git");
const hooksDir = join(gitDir, "hooks");
const source = join(repoRoot, "scripts", "update-build-date.cjs");
const target = join(hooksDir, "pre-commit");
const hooksPackageJson = join(hooksDir, "package.json");

function isGitWorktreeOrRepo(dir) {
  try {
    const stats = statSync(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

if (!isGitWorktreeOrRepo(gitDir)) {
  console.log("No .git directory found; skipping hook installation.");
  process.exit(0);
}

if (!existsSync(source)) {
  console.error(`Hook source not found: ${source}`);
  process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });

if (existsSync(target)) {
  const force = process.argv.includes("--force") || process.argv.includes("-f");
  if (!force) {
    console.log(`Pre-commit hook already exists: ${target}`);
    console.log("Use --force to overwrite, or leave the existing hook in place.");
    process.exit(0);
  }
  console.log(`Overwriting existing pre-commit hook: ${target}`);
}

copyFileSync(source, target);

// Force Node to treat the extensionless hook as CommonJS despite repo "type": "module".
writeFileSync(hooksPackageJson, JSON.stringify({ type: "commonjs" }) + "\n", "utf-8");

if (process.platform !== "win32") {
  chmodSync(target, 0o755);
}

console.log("Installed build-date pre-commit hook.");
