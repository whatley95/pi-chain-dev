/**
 * Configuration loading for pi-chain-dev.
 *
 * Reads from ~/.pi/agent/settings.json and .pi/settings.json
 * under the "pi-chain-dev" key.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { AutoForkConfig, StageProfile, ForkThinkingLevel, PromptsConfig, YoloConfig, ConfidenceGateConfig } from "./types.js";
import { normalizeYoloConfig, normalizeConfidenceGates } from "./types.js";
import { logError } from "./logger.js";

let getAgentDirImpl: () => string;
try {
  // Dynamic import is used because this package is a peer dependency provided by
  // the Pi runtime. A static import would fail type-checking and bundling when
  // the dependency is not physically installed in this package's tree.
  const pi = await import("@earendil-works/pi-coding-agent");
  getAgentDirImpl = pi.getAgentDir;
} catch {
  getAgentDirImpl = () => path.join(homedir(), ".pi", "agent");
}

export function getAgentDir(): string {
  return getAgentDirImpl();
}

export const EFFORT_LEVELS = ["fast", "balanced", "deep"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "pi-chain-dev";
const FALLBACK_KEY = "pi-fork"; // fall back to pi-fork's effort profiles if ours aren't set

export type { AutoForkConfig };

export const DEFAULT_CONFIG: AutoForkConfig = {
  stage1: { provider: "", id: "", thinking: "minimal" },
  stage2: { provider: "", id: "", thinking: "xhigh" },
  extensions: null,
  environment: {},
  offline: true,
  costFooter: true,
  auto: false,
  promptsEnabled: true,
  memory: true,
  themed: false,
  autoVerify: false,
  signature: undefined,
  maxForkCost: 0,
  maxSessionCost: 0,
  confidenceGates: {
    minFindings: 3,
    maxLowConfidenceRatio: 0.5,
    minFileAnchors: 1,
    minCommandEvidence: 1,
    autoReExplore: true,
  },
  yolo: {
    enabled: false,
    maxRounds: 3,
    stopOnPass: true,
    autoApply: "manual",
  },
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
    // No cwd available here; log to console is not allowed. Caller will use defaults.
    return undefined;
  }
}

export function loadConfig(cwd: string): AutoForkConfig {
  const agentDir = getAgentDir();
  const globalPath = path.join(agentDir, "settings.json");
  const projectSettingsDir = path.join(cwd, ".pi");
  const projectPath = path.join(projectSettingsDir, "settings.json");

  // Load our namespace from global and project settings
  const globalConfig = readNamespacedConfig(cwd, globalPath);
  const projectConfig = readNamespacedConfig(cwd, projectPath);

  const resolved: AutoForkConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    stage1: projectConfig.stage1 || globalConfig.stage1 || DEFAULT_CONFIG.stage1,
    stage1b: projectConfig.stage1b || globalConfig.stage1b,
    stage1c: projectConfig.stage1c || globalConfig.stage1c,
    stage1Backup: projectConfig.stage1Backup || globalConfig.stage1Backup,
    stage2: projectConfig.stage2 || globalConfig.stage2 || DEFAULT_CONFIG.stage2,
    // Deep-merge prompts so project can override individual keys without losing global
    prompts: {
      ...DEFAULT_CONFIG.prompts,
      ...globalConfig.prompts,
      ...projectConfig.prompts,
    },
    // Deep-merge confidence gates so project can tune thresholds without losing defaults
    confidenceGates: normalizeConfidenceGates({
      ...DEFAULT_CONFIG.confidenceGates,
      ...globalConfig.confidenceGates,
      ...projectConfig.confidenceGates,
    }),
    // Deep-merge yolo config so project can toggle enabled without losing global profiles
    yolo: normalizeYoloConfig({
      ...DEFAULT_CONFIG.yolo,
      ...globalConfig.yolo,
      ...projectConfig.yolo,
    }),
    // Project-level override wins
    promptsEnabled: projectConfig.promptsEnabled ?? globalConfig.promptsEnabled ?? DEFAULT_CONFIG.promptsEnabled,
    memory: projectConfig.memory ?? globalConfig.memory ?? DEFAULT_CONFIG.memory,
    themed: projectConfig.themed ?? globalConfig.themed ?? DEFAULT_CONFIG.themed,
    autoVerify: projectConfig.autoVerify ?? globalConfig.autoVerify ?? DEFAULT_CONFIG.autoVerify,
    signature: projectConfig.signature ?? globalConfig.signature,
  };

  // If no stage profiles configured, try falling back to pi-fork effort profiles
  if (!resolved.stage1.provider || !resolved.stage1.id ||
      !resolved.stage2.provider || !resolved.stage2.id) {
    const piForkProfiles = resolveEffortProfilesFromPiFork(globalPath) ||
                           resolveEffortProfilesFromPiFork(projectPath);

    if (piForkProfiles) {
      if (!resolved.stage1.provider || !resolved.stage1.id) {
        const s1 = piForkProfiles["fast"] || piForkProfiles["balanced"] || piForkProfiles["deep"];
        if (s1) resolved.stage1 = s1;
      }
      if (!resolved.stage2.provider || !resolved.stage2.id) {
        const s2 = piForkProfiles["deep"] || piForkProfiles["balanced"];
        if (s2) resolved.stage2 = s2;
      }
    }
  }

  return resolved;
}

function readNamespacedConfig(cwd: string, settingsPath: string): Partial<AutoForkConfig> {
  if (!existsSync(settingsPath)) return {};

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const nested = raw[SETTINGS_KEY];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return {};

    const config = nested as Record<string, unknown>;
    const parsed: Partial<AutoForkConfig> = {};

    const stage1 = parseStageProfile(config.stage1);
    const stage1b = parseStageProfile(config.stage1b);
    const stage1c = parseStageProfile(config.stage1c);
    const stage1Backup = parseStageProfile(config.stage1Backup);
    const stage2 = parseStageProfile(config.stage2);
    const review = parseStageProfile(config.review);

    const yoloRaw = config.yolo && typeof config.yolo === "object" ? config.yolo as Record<string, unknown> : undefined;
    const yoloReview = parseStageProfile(yoloRaw?.reviewProfile);
    const yoloFix = parseStageProfile(yoloRaw?.fixProfile);

    if (stage1) parsed.stage1 = stage1;
    if (stage1b) parsed.stage1b = stage1b;
    if (stage1c) parsed.stage1c = stage1c;
    if (stage1Backup) parsed.stage1Backup = stage1Backup;
    if (stage2) parsed.stage2 = stage2;
    if (review) parsed.review = review;
    if (typeof config.offline === "boolean") parsed.offline = config.offline;
    if (typeof config.costFooter === "boolean") parsed.costFooter = config.costFooter;
    if (typeof config.auto === "boolean") parsed.auto = config.auto;
    if (typeof config.promptsEnabled === "boolean") parsed.promptsEnabled = config.promptsEnabled;
    if (typeof config.memory === "boolean") parsed.memory = config.memory;
    if (typeof config.themed === "boolean") parsed.themed = config.themed;
    if (typeof config.autoVerify === "boolean") parsed.autoVerify = config.autoVerify;
    if (typeof config.signature === "string") parsed.signature = config.signature;
    if (typeof config.parallel === "number") parsed.parallel = Math.max(1, Math.min(3, Number.isFinite(config.parallel) ? config.parallel : 1));
    if (typeof config.parallelBackup === "boolean") parsed.parallelBackup = config.parallelBackup;
    if (typeof config.maxForkCost === "number") parsed.maxForkCost = Math.max(0, Number.isFinite(config.maxForkCost) ? config.maxForkCost : 0);
    if (typeof config.maxSessionCost === "number") parsed.maxSessionCost = Math.max(0, Number.isFinite(config.maxSessionCost) ? config.maxSessionCost : 0);

    // Parse confidence gates
    if (config.confidenceGates && typeof config.confidenceGates === "object") {
      const gates = config.confidenceGates as Record<string, unknown>;
      const parsedGates: ConfidenceGateConfig = {};
      if (typeof gates.minFindings === "number") parsedGates.minFindings = gates.minFindings;
      if (typeof gates.maxLowConfidenceRatio === "number") parsedGates.maxLowConfidenceRatio = gates.maxLowConfidenceRatio;
      if (typeof gates.minFileAnchors === "number") parsedGates.minFileAnchors = gates.minFileAnchors;
      if (typeof gates.minCommandEvidence === "number") parsedGates.minCommandEvidence = gates.minCommandEvidence;
      if (typeof gates.autoReExplore === "boolean") parsedGates.autoReExplore = gates.autoReExplore;
      parsed.confidenceGates = parsedGates;
    }

    // Parse yolo config
    if (config.yolo && typeof config.yolo === "object") {
      const yolo = config.yolo as Record<string, unknown>;
      const parsedYolo: YoloConfig = {};
      if (typeof yolo.enabled === "boolean") parsedYolo.enabled = yolo.enabled;
      if (typeof yolo.maxRounds === "number") parsedYolo.maxRounds = yolo.maxRounds;
      if (typeof yolo.stopOnPass === "boolean") parsedYolo.stopOnPass = yolo.stopOnPass;
      if (typeof yolo.autoApply === "string" && ["manual", "propose", "auto"].includes(yolo.autoApply)) {
        parsedYolo.autoApply = yolo.autoApply as "manual" | "propose" | "auto";
      }
      if (yoloReview) parsedYolo.reviewProfile = yoloReview;
      if (yoloFix) parsedYolo.fixProfile = yoloFix;
      parsed.yolo = parsedYolo;
    }

    // Parse prompts
    if (config.prompts && typeof config.prompts === "object") {
      const prompts = config.prompts as Record<string, unknown>;
      const parsedPrompts: Record<string, string> = {};
      for (const key of ["explore", "synthesize", "plan", "review"]) {
        if (typeof prompts[key] === "string" && (prompts[key] as string).trim()) {
          parsedPrompts[key] = (prompts[key] as string).trim();
        }
      }
      if (Object.keys(parsedPrompts).length > 0) {
        parsed.prompts = parsedPrompts as PromptsConfig;
      }
    }

    // Parse extensions
    if (Array.isArray(config.extensions)) {
      parsed.extensions = config.extensions.filter((item): item is string => typeof item === "string" && item.length > 0);
    } else if (config.extensions === null) {
      parsed.extensions = null;
    }

    // Parse environment variables
    if (config.environment && typeof config.environment === "object" && !Array.isArray(config.environment)) {
      const env = config.environment as Record<string, unknown>;
      const parsedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
          parsedEnv[key] = value;
        }
      }
      if (Object.keys(parsedEnv).length > 0) {
        parsed.environment = parsedEnv;
      }
    }

    return parsed;
  } catch (err) {
    logError(cwd, "readNamespacedConfig", err, { settingsPath });
    return {};
  }
}
