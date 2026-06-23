/**
 * Structured debug/error logging for cdev persistence and runtime events.
 *
 * Writes JSONL records to `.pi/cdev/debug.log`. Errors are also mirrored to
 * `.pi/cdev/errors.jsonl` so existing error-trail consumers keep working.
 *
 * Enable debug output with the `CDEV_DEBUG=1` environment variable or by
 * calling `initLogger({ debug: true })`.
 */

import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalMinLevel: LogLevel = "info";
let globalDebugEnabled = false;

function envDebugEnabled(): boolean {
  return process.env.CDEV_DEBUG === "1" || process.env.CDEV_DEBUG === "true";
}

export function initLogger(opts?: { level?: LogLevel; debug?: boolean }): void {
  if (opts?.level) globalMinLevel = opts.level;
  if (opts?.debug !== undefined) {
    globalDebugEnabled = opts.debug;
  } else if (envDebugEnabled()) {
    globalDebugEnabled = true;
  }
  if (globalDebugEnabled && LEVELS[globalMinLevel] > LEVELS.debug) {
    globalMinLevel = "debug";
  }
}

export function getMinLogLevel(): LogLevel {
  return globalMinLevel;
}

export function isDebugEnabled(): boolean {
  return globalDebugEnabled;
}

function formatError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  if (err && typeof err === "object" && "message" in err && typeof (err as Record<string, unknown>).message === "string") {
    return { message: (err as Record<string, unknown>).message as string };
  }
  return { message: String(err) };
}

function cdevDir(cwd: string): string {
  return join(cwd, ".pi", "cdev");
}

const ensuredDirs = new Set<string>();

function ensureCdevDir(cwd: string): void {
  const dir = cdevDir(cwd);
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
}

export function debugLogPath(cwd: string): string {
  return join(cdevDir(cwd), "debug.log");
}

export function errorLogPath(cwd: string): string {
  return join(cdevDir(cwd), "errors.jsonl");
}

function writeDebugLog(
  cwd: string,
  level: LogLevel,
  context: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVELS[level] < LEVELS[globalMinLevel]) return;
  try {
    ensureCdevDir(cwd);
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      context,
      message,
      ...meta,
    });
    appendFileSync(debugLogPath(cwd), record + "\n", "utf-8");
  } catch {
    // Last-resort silence: if logging itself fails, avoid crashing the caller.
  }
}

function writeErrorLog(
  cwd: string,
  context: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  try {
    ensureCdevDir(cwd);
    const { message, stack } = formatError(err);
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      context,
      message,
      stack,
      ...meta,
    });
    appendFileSync(errorLogPath(cwd), record + "\n", "utf-8");
  } catch {
    // fail silently
  }
}

export function logDebug(
  cwd: string,
  context: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  writeDebugLog(cwd, "debug", context, message, meta);
}

export function logInfo(
  cwd: string,
  context: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  writeDebugLog(cwd, "info", context, message, meta);
}

export function logWarn(
  cwd: string,
  context: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  writeDebugLog(cwd, "warn", context, message, meta);
}

export function logError(
  cwd: string,
  context: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  const { message, stack } = formatError(err);
  writeDebugLog(cwd, "error", context, message, { stack, ...meta });
  writeErrorLog(cwd, context, err, meta);
}

/** Read the number of error records currently stored in errors.jsonl. */
export function getErrorCount(cwd: string): number {
  try {
    const path = errorLogPath(cwd);
    if (!existsSync(path)) return 0;
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return 0;
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/** Clear the error log file. */
export function clearErrorLog(cwd: string): void {
  try {
    const path = errorLogPath(cwd);
    if (existsSync(path)) writeFileSync(path, "", "utf-8");
  } catch {
    // ignore
  }
}

// Initialise from environment on first load.
initLogger();
