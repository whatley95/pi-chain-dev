/** Type definitions for pi-chain-dev. */

// ── Fork types ──

export type ForkEffort = "fast" | "balanced" | "deep";
export type ForkThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Model profile for a single stage. */
export interface StageProfile {
  provider: string;
  id: string;
  thinking: ForkThinkingLevel;
}

export interface PromptsConfig {
  /** Custom prompt for Stage 1 exploration. */
  explore?: string;
  /** Custom prompt for Stage 2 synthesis. */
  synthesize?: string;
  /** Custom prompt for review mode. */
  review?: string;
}

/** Configuration stored under "pi-chain-dev" key in settings.json. */
export interface AutoForkConfig {
  /** Model profile for Stage 1 (cheap exploration). */
  stage1: StageProfile;
  /** Model profile for Stage 2 (expensive synthesis). */
  stage2: StageProfile;
  /** Custom prompts for each stage. */
  prompts?: PromptsConfig;
  /** Extensions to load in child processes. null = normal, [] = none. */
  extensions: string[] | null;
  /** Environment variables to overlay onto child processes. */
  environment: Record<string, string>;
  /** Whether child processes force Pi offline mode. */
  offline: boolean;
  /** Show cdev cost as an extra footer status line. */
  costFooter: boolean;
  /** Auto-trigger mode: LLM proactively uses cdev for exploration tasks. */
  auto: boolean;
  /** Whether custom prompts are active (toggle off to use generic). */
  promptsEnabled: boolean;
  /** Whether project-level memory is enabled (cross-session findings). */
  memory: boolean;
  /** Custom signature shown in /cdev status (e.g. name, handle). */
  signature?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ForkResult {
  task: string;
  exitCode: number;
  messages: { role: string; content: unknown; [key: string]: unknown }[];
  stderr: string;
  usage: UsageStats;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface AutoForkState {
  stage1Profile: StageProfile;
  stage2Profile: StageProfile;
}

export interface AutoForkDetails {
  stage1: ForkResult | null;
  stage2: ForkResult | null;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function emptyFailedResult(task: string, message: string): ForkResult {
  return {
    task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: message,
  };
}

// ── Project-level memory types ──

export interface CdevMemory {
  version: 1;
  topics: Record<string, CdevTopic>;
}

export interface CdevTopic {
  /** Topic key (e.g. "auth", "payment-gateway"). */
  name: string;
  /** All findings for this topic, newest first. */
  findings: CdevFindingRecord[];
  /** Total number of forks on this topic. */
  forkCount: number;
  /** Timestamp when this topic was first explored. */
  firstSeen: number;
  /** Timestamp of most recent fork. */
  lastSeen: number;
  /** All file paths ever referenced across findings. */
  files: string[];
}

export interface CdevFindingRecord {
  /** One-line finding text. */
  text: string;
  /** Timestamp when the fork ran. */
  timestamp: number;
  /** Which stage produced this finding. */
  stage: "stage1" | "stage2" | "review";
  /** Model chain used (e.g. "flash→pro" or "pro" for review). */
  models: string;
  /** Cost of the fork that produced this finding. */
  cost: number;
  /** SHA256 hashes of files that support this finding (path → hash). */
  fileFingerprints?: Record<string, string>;
}
