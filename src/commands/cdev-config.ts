/**
 * Config handler for cdev — /cdev config subcommand.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkConfig } from "../config.js";
import { readAgentSettings, readProjectSettings, writeAgentSetting, writeProjectSetting } from "../settings-helpers.js";

function formatConfigValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "number") return Number.isInteger(value) ? value.toString() : value.toFixed(4);
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.provider && obj.id) return `${obj.provider}:${obj.id} • ${obj.thinking ?? "?"}`;
  }
  return JSON.stringify(value);
}

function parseBooleanValue(raw: string): boolean | null {
  const lower = raw.toLowerCase();
  if (["on", "true", "yes", "1"].includes(lower)) return true;
  if (["off", "false", "no", "0"].includes(lower)) return false;
  return null;
}

const CONFIG_KEYS: Record<string, { type: "boolean" | "number" | "seconds" | "profileTimeouts"; min?: number; max?: number }> = {
  auto: { type: "boolean" },
  autoVerify: { type: "boolean" },
  autoCompactOnLimit: { type: "boolean" },
  memory: { type: "boolean" },
  memoryAutoRefresh: { type: "boolean" },
  promptsEnabled: { type: "boolean" },
  themed: { type: "boolean" },
  parallelBackup: { type: "boolean" },
  parallel: { type: "number", min: 1, max: 3 },
  scoutTimeoutMs: { type: "seconds", min: 30, max: 3600 },
  forgeTimeoutMs: { type: "seconds", min: 30, max: 3600 },
  profileTimeouts: { type: "profileTimeouts" },
  modelContextLimit: { type: "number", min: 8192, max: 2000000 },
  tokenEstimationCharsPerToken: { type: "number", min: 1, max: 64 },
  maxForkCost: { type: "number", min: 0 },
  maxSessionCost: { type: "number", min: 0 },
};

export async function handleConfig(trimmed: string, ctx: ExtensionContext, config: AutoForkConfig): Promise<boolean> {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("config")) return false;
  const rest = trimmed.slice(6).trim();

  if (!rest) {
    const agent = readAgentSettings();
    const project = readProjectSettings(ctx.cwd);
    const lines = [
      "── cdev config ─────────────────────────────────────",
      "",
      "Key                          | Value        | Source",
      "─────────────────────────────────────────────────────",
    ];
    for (const key of Object.keys(CONFIG_KEYS)) {
      const value = (config as unknown as Record<string, unknown>)[key];
      const source = project[key] !== undefined ? "project" : agent[key] !== undefined ? "agent" : "default";
      lines.push(`${key.padEnd(28)} | ${formatConfigValue(value).padEnd(12)} | ${source}`);
    }
    lines.push("");
    lines.push("Profiles:");
    lines.push(`  stage1  ${formatConfigValue(config.stage1)}`);
    lines.push(`  stage2  ${formatConfigValue(config.stage2)}`);
    if (config.review) lines.push(`  review  ${formatConfigValue(config.review)}`);
    if (config.research) lines.push(`  research ${formatConfigValue(config.research)}`);
    lines.push("");
    lines.push("Usage: /cdev config <key> <value>");
    lines.push("       /cdev config project <key> <value>");
    lines.push("─────────────────────────────────────────────────────");
    ctx.ui.notify(lines.join("\n"), "info");
    return true;
  }

  const parts = rest.split(/\s+/);
  const isProject = parts[0] === "project";
  if (isProject) parts.shift();

  if (parts.length >= 1 && parts[0].startsWith("profileTimeouts.")) {
    const nestedKey = parts[0].slice("profileTimeouts.".length);
    const validFields = ["scout", "forge", "research", "review", "yoloReview", "yoloFix"];
    if (!validFields.includes(nestedKey)) {
      ctx.ui.notify(`Unknown profileTimeouts field "${nestedKey}". Use one of: ${validFields.join(", ")}`, "warn");
      return true;
    }
    if (parts.length === 1) {
      const value = (config.profileTimeouts as Record<string, unknown> | undefined)?.[nestedKey];
      ctx.ui.notify(`profileTimeouts.${nestedKey}: ${formatConfigValue(value)}`, "info");
      return true;
    }
    const rawValue = parts.slice(1).join(" ");
    const seconds = parseInt(rawValue, 10);
    if (Number.isNaN(seconds)) {
      ctx.ui.notify(`Invalid number "${rawValue}".`, "warn");
      return true;
    }
    const clamped = Math.max(30, Math.min(3600, seconds));
    const merged: Record<string, number> = { ...(config.profileTimeouts ?? {}) };
    merged[nestedKey] = clamped * 1000;
    if (isProject) {
      writeProjectSetting(ctx.cwd, "profileTimeouts", merged);
      ctx.ui.notify(`Set project config profileTimeouts.${nestedKey} = ${clamped}s`, "info");
    } else {
      writeAgentSetting("profileTimeouts", merged);
      ctx.ui.notify(`Set agent config profileTimeouts.${nestedKey} = ${clamped}s`, "info");
    }
    return true;
  }

  if (parts.length === 1) {
    const key = parts[0];
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value === undefined) {
      ctx.ui.notify(`Unknown config key "${key}". Use /cdev config to list keys.`, "warn");
      return true;
    }
    ctx.ui.notify(`${key}: ${formatConfigValue(value)}`, "info");
    return true;
  }

  if (parts.length >= 2) {
    const key = parts[0];
    const rawValue = parts.slice(1).join(" ");
    const schema = CONFIG_KEYS[key];
    if (!schema) {
      ctx.ui.notify(`Unknown config key "${key}". Use /cdev config to list keys.`, "warn");
      return true;
    }

    let parsed: unknown;
    if (schema.type === "boolean") {
      const bool = parseBooleanValue(rawValue);
      if (bool === null) {
        ctx.ui.notify(`Invalid boolean value "${rawValue}". Use on/off or true/false.`, "warn");
        return true;
      }
      parsed = bool;
    } else if (schema.type === "seconds") {
      const seconds = parseInt(rawValue, 10);
      if (Number.isNaN(seconds)) {
        ctx.ui.notify(`Invalid number "${rawValue}".`, "warn");
        return true;
      }
      const clamped = Math.max(schema.min ?? 1, Math.min(schema.max ?? Number.MAX_SAFE_INTEGER, seconds));
      parsed = clamped * 1000;
    } else if (schema.type === "profileTimeouts") {
      ctx.ui.notify(`Use /cdev config profileTimeouts.<field> <seconds> where field is one of: scout, forge, research, review, yoloReview, yoloFix`, "warn");
      return true;
    } else {
      const num = parseFloat(rawValue);
      if (Number.isNaN(num)) {
        ctx.ui.notify(`Invalid number "${rawValue}".`, "warn");
        return true;
      }
      parsed = Math.max(schema.min ?? -Infinity, Math.min(schema.max ?? Infinity, num));
    }

    if (isProject) {
      writeProjectSetting(ctx.cwd, key, parsed);
      ctx.ui.notify(`Set project config ${key} = ${formatConfigValue(parsed)}`, "info");
    } else {
      writeAgentSetting(key, parsed);
      ctx.ui.notify(`Set agent config ${key} = ${formatConfigValue(parsed)}`, "info");
    }
    return true;
  }

  return false;
}
