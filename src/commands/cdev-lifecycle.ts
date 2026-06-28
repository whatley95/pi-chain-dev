/**
 * Lifecycle handlers for cdev — session start/end cleanup.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { purgeOldSessions } from "../history.js";
import { writeProjectSetting } from "../settings-helpers.js";

export function clearReports(reportsDir: string): number {
  if (!existsSync(reportsDir)) return 0;
  let cleared = 0;
  for (const entry of readdirSync(reportsDir)) {
    if (entry.endsWith(".md")) {
      unlinkSync(join(reportsDir, entry));
      cleared++;
    }
  }
  return cleared;
}

export function writeProjectThemed(cwd: string, enable: boolean): void {
  writeProjectSetting(cwd, "themed", enable);
}

export function registerLifecycleHandlers(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  const purged = purgeOldSessions(ctx.cwd, 7);
  if (purged > 0) {
    ctx.ui.notify(`Purged ${purged} old cdev session${purged > 1 ? "s" : ""} (>7 days)`, "info");
  }

  let purgedReports = 0;
  const reportsDir = join(ctx.cwd, ".pi", "cdev", "reports");
  if (existsSync(reportsDir)) {
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(reportsDir)) {
      if (!entry.endsWith(".md")) continue;
      if (now - statSync(join(reportsDir, entry)).mtimeMs > week) {
        unlinkSync(join(reportsDir, entry));
        purgedReports++;
      }
    }
  }
  if (purgedReports > 0) {
    ctx.ui.notify(`Purged ${purgedReports} old cdev report${purgedReports > 1 ? "s" : ""} (>7 days)`, "info");
  }

  const sentinelPath = join(ctx.cwd, ".pi", ".cdev-ignore-ok");
  if (!existsSync(sentinelPath)) {
    let warned = false;
    if (existsSync(join(ctx.cwd, ".git"))) {
      const gitignorePath = join(ctx.cwd, ".gitignore");
      if (!existsSync(gitignorePath)) {
        try {
          writeFileSync(gitignorePath, ".pi/\n", "utf-8");
          ctx.ui.notify("Created .gitignore with .pi/ — cdev data now excluded from version control.", "info");
        } catch { /* read-only fs */ }
        warned = true;
      } else {
        const gi = readFileSync(gitignorePath, "utf-8");
        if (!(/^\.pi[/\s]|^\.pi$/m.test(gi) || gi.includes(".pi/"))) {
          ctx.ui.notify(".pi/ is not gitignored — cdev data may leak to version control. Add '.pi/' to .gitignore.", "warn");
          warned = true;
        }
      }
    }
    if (!warned && existsSync(join(ctx.cwd, ".svn"))) {
      try {
        const result = spawnSync("svn", ["propget", "svn:ignore", "."], { cwd: ctx.cwd, encoding: "utf-8", timeout: 5000 });
        const svnIgnore = (result.stdout || "").trim();
        if (!svnIgnore.split(/[\r\n]+/).some((line: string) => line.trim() === ".pi")) {
          ctx.ui.notify(".pi/ is not in svn:ignore — cdev data may leak to version control. Run: svn propset svn:ignore '.pi' .", "warn");
          warned = true;
        }
      } catch { /* svn not available */ }
    }
    if (!warned) {
      try { mkdirSync(join(ctx.cwd, ".pi"), { recursive: true }); writeFileSync(sentinelPath, "", "utf-8"); } catch { /* ignore */ }
    }
  }
}
