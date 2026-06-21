/**
 * Configuration loading for pi-chain-dev.
 *
 * Reads from ~/.pi/agent/settings.json and .pi/settings.json
 * under the "pi-chain-dev" key.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutoForkConfig, StageProfile, ForkThinkingLevel, PromptsConfig } from "./types.js";

export const EFFORT_LEVELS = ["fast", "balanced", "deep"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "pi-chain-dev";
const FALLBACK_KEY = "pi-fork"; // fall back to pi-fork's effort profiles if ours aren't set

export const DEFAULT_CONFIG: AutoForkConfig = {
  stage1: { provider: "", id: "", thinking: "minimal" },
  stage2: { provider: "", id: "", thinking: "xhigh" },
  extensions: null,
  environment: {},
  offline: true,
  costFooter: true,
  auto: false,
  promptsEnabled: true,
};

function isThinkingLevel(value: unknown): value is ForkThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseStageProfile(raw: unknown): StageProfile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const profile = raw as Record<string, unknown>;
  const provider = typeof profile.provider === "string" ? profile.provider.trim() : "";
  const id = typeof profile.id === "string" ? profile.id.trim() : "";
  if (!provider || !id || !isThinkingLevel(profile.thinking)) return undefined;
  return { provider, id, thinking: profile.thinking as ForkThinkingLevel };
}

function resolveEffortProfilesFromPiFork(
  settingsPath: string,
): Partial<Record<string, StageProfile>> | undefined {
  if (!existsSync(settingsPath)) return undefined;

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const nested = raw[FALLBACK_KEY];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;

    const config = nested as Record<string, unknown>;
    const effortProfiles = config.effortProfiles;
    if (!effortProfiles || typeof effortProfiles !== "object") return undefined;

    const profiles: Record<string, StageProfile> = {};
    for (const level of EFFORT_LEVELS) {
      const rawProfile = (effortProfiles as Record<string, unknown>)[level];
      const profile = parseStageProfile(rawProfile);
      if (profile) profiles[level] = profile;
    }
    return Object.keys(profiles).length > 0 ? profiles : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(cwd: string): AutoForkConfig {
  const agentDir = getAgentDir();
  const globalPath = path.join(agentDir, "settings.json");
  const projectSettingsDir = path.join(cwd, ".pi");
  const projectPath = path.join(projectSettingsDir, "settings.json");

  // Load our namespace from global and project settings
  const globalConfig = readNamespacedConfig(globalPath);
  const projectConfig = readNamespacedConfig(projectPath);

  const resolved: AutoForkConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    stage1: projectConfig.stage1 || globalConfig.stage1 || DEFAULT_CONFIG.stage1,
    stage2: projectConfig.stage2 || globalConfig.stage2 || DEFAULT_CONFIG.stage2,
    // Deep-merge prompts so project can override individual keys without losing global
    prompts: {
      ...DEFAULT_CONFIG.prompts,
      ...globalConfig.prompts,
      ...projectConfig.prompts,
    },
    // Project-level override wins
    promptsEnabled: projectConfig.promptsEnabled ?? globalConfig.promptsEnabled ?? DEFAULT_CONFIG.promptsEnabled,
  };

  // If no stage profiles configured, try falling back to pi-fork effort profiles
  if (!resolved.stage1.provider || !resolved.stage1.id ||
      !resolved.stage2.provider || !resolved.stage2.id) {
    const piForkProfiles = resolveEffortProfilesFromPiFork(globalPath) ||
                           resolveEffortProfilesFromPiFork(projectPath);

    if (piForkProfiles) {
      if (!resolved.stage1.provider || !resolved.stage1.id) {
        // fast → stage1, deep → stage2, balanced → fallback to either
        const s1 = piForkProfiles["fast"] || piForkProfiles["balanced"] || piForkProfiles["deep"];
        const s2 = piForkProfiles["deep"] || piForkProfiles["balanced"];
        if (s1) resolved.stage1 = s1;
        if (s2) resolved.stage2 = s2;
      }
    }
  }

  return resolved;
}

function readNamespacedConfig(settingsPath: string): Partial<AutoForkConfig> {
  if (!existsSync(settingsPath)) return {};

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const nested = raw[SETTINGS_KEY];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return {};

    const config = nested as Record<string, unknown>;
    const parsed: Partial<AutoForkConfig> = {};

    const stage1 = parseStageProfile(config.stage1);
    const stage2 = parseStageProfile(config.stage2);

    if (stage1) parsed.stage1 = stage1;
    if (stage2) parsed.stage2 = stage2;
    if (typeof config.offline === "boolean") parsed.offline = config.offline;
    if (typeof config.costFooter === "boolean") parsed.costFooter = config.costFooter;
    if (typeof config.auto === "boolean") parsed.auto = config.auto;
    if (typeof config.promptsEnabled === "boolean") parsed.promptsEnabled = config.promptsEnabled;

    // Parse prompts
    if (config.prompts && typeof config.prompts === "object") {
      const prompts = config.prompts as Record<string, unknown>;
      const parsedPrompts: Record<string, string> = {};
      for (const key of ["explore", "synthesize", "review"]) {
        if (typeof prompts[key] === "string" && (prompts[key] as string).trim()) {
          parsedPrompts[key] = (prompts[key] as string).trim();
        }
      }
      if (Object.keys(parsedPrompts).length > 0) {
        parsed.prompts = parsedPrompts as PromptsConfig;
      }
    }

    return parsed;
  } catch {
    return {};
  }
}
