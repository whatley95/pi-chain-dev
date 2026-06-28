import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logError } from "./logger.js";
import { invalidateConfigCache } from "./config.js";

export function writeAgentSetting(key: string, value: unknown): void {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }
    if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
    (settings["pi-chain-dev"] as Record<string, unknown>)[key] = value;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch (err) {
    logError(agentDir, "writeAgentSetting", err, { key });
    throw err;
  }
  invalidateConfigCache();
}

export function readAgentSetting(key: string): unknown {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  try {
    if (!existsSync(settingsPath)) return undefined;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const cdev = settings["pi-chain-dev"] as Record<string, unknown> | undefined;
    return cdev?.[key];
  } catch (err) {
    logError(agentDir, "readAgentSetting", err, { key });
    return undefined;
  }
}

export function readProjectSetting(cwd: string, key: string): unknown {
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  try {
    if (!existsSync(projectSettingsPath)) return undefined;
    const settings = JSON.parse(readFileSync(projectSettingsPath, "utf-8")) as Record<string, unknown>;
    const cdev = settings["pi-chain-dev"] as Record<string, unknown> | undefined;
    return cdev?.[key];
  } catch (err) {
    logError(cwd, "readProjectSetting", err, { key });
    return undefined;
  }
}

export function readAgentSettings(): Record<string, unknown> {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  try {
    if (!existsSync(settingsPath)) return {};
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    return (settings["pi-chain-dev"] as Record<string, unknown>) ?? {};
  } catch (err) {
    logError(agentDir, "readAgentSettings", err);
    return {};
  }
}

export function readProjectSettings(cwd: string): Record<string, unknown> {
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  try {
    if (!existsSync(projectSettingsPath)) return {};
    const settings = JSON.parse(readFileSync(projectSettingsPath, "utf-8")) as Record<string, unknown>;
    return (settings["pi-chain-dev"] as Record<string, unknown>) ?? {};
  } catch (err) {
    logError(cwd, "readProjectSettings", err);
    return {};
  }
}

export function writeProjectSetting(cwd: string, key: string, value: unknown): void {
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  let projSettings: Record<string, unknown> = {};
  try {
    if (existsSync(projectSettingsPath)) {
      projSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
    }
    if (!projSettings["pi-chain-dev"]) projSettings["pi-chain-dev"] = {};
    (projSettings["pi-chain-dev"] as Record<string, unknown>)[key] = value;
    writeFileSync(projectSettingsPath, JSON.stringify(projSettings, null, 2) + "\n", "utf-8");
  } catch (err) {
    logError(cwd, "writeProjectSetting", err, { key });
    throw err;
  }
  invalidateConfigCache(cwd);
}
