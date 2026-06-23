import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logError } from "./logger.js";

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
}
