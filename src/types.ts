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
  /** Optional second scout model for verify mode. Falls back to stage1 if unset. */
  stage1b?: StageProfile;
  /** Model profile for Stage 2 (expensive synthesis). */
  stage2: StageProfile;
  /** Optional override model for review mode. Falls back to stage2 if unset. */
  review?: StageProfile;
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
  /** Use theme.bg() for richer TUI rendering (progress, results). Default true. */
  themed: boolean;
  /** Run scout twice automatically for higher accuracy. */
  autoVerify: boolean;
  /** Custom signature shown in /cdev status (e.g. name, handle). */
  signature?: string;
  /** Maximum cost (USD) for a single fork. 0 = unlimited. */
  maxForkCost?: number;
  /** Maximum total cost (USD) for cdev in the current session. 0 = unlimited. */
  maxSessionCost?: number;
  /** YOLO mode: auto review → fix loops. */
  yolo?: YoloConfig;
}

/** YOLO (auto review-fix) configuration. */
export interface YoloConfig {
  /** Enable the /cdev yolo command. */
  enabled?: boolean;
  /** Maximum review-fix rounds. Default 3, hard cap 7. */
  maxRounds?: number;
  /** Stop looping when review returns pass. Default true. */
  stopOnPass?: boolean;
  /** How aggressively to auto-apply fixes. Default 'off'. */
  autoApply?: "off" | "safe" | "all";
  /** Model profile for yolo review rounds. Falls back to stage2. */
  reviewProfile?: StageProfile;
  /** Model profile for yolo fix rounds. Falls back to stage2. */
  fixProfile?: StageProfile;
}

export function normalizeYoloConfig(config?: YoloConfig): Required<Omit<YoloConfig, "reviewProfile" | "fixProfile">> & Pick<YoloConfig, "reviewProfile" | "fixProfile"> {
  const max = config?.maxRounds ?? 3;
  return {
    enabled: config?.enabled ?? false,
    maxRounds: max > 7 ? 7 : max < 1 ? 1 : max,
    stopOnPass: config?.stopOnPass ?? true,
    autoApply: config?.autoApply ?? "off",
    reviewProfile: config?.reviewProfile,
    fixProfile: config?.fixProfile,
  };
}

export function formatYoloStatus(config?: YoloConfig): string {
  const normalized = normalizeYoloConfig(config);
  if (!normalized.enabled) return "OFF";
  return `ON (max ${normalized.maxRounds} rounds, auto-apply ${normalized.autoApply})`;
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
  /** Internal retry tracking populated by runner-events. */
  retry?: {
    active?: boolean;
    pending?: boolean;
    success?: boolean;
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
    errorMessage?: string;
    finalError?: string;
    history?: { type: "start" | "end"; [key: string]: unknown }[];
  };
  /** Internal activity tracking populated by runner-events. */
  thinking?: { status?: string; tokens?: number; activityOrder?: number; [key: string]: unknown };
  activities?: { type?: string; status?: string; activityOrder?: number; [key: string]: unknown }[];
  toolExecutions?: { toolCallId?: string; toolName?: string; status?: string; activityOrder?: number; [key: string]: unknown }[];
  activityCount?: number;
  toolExecutionCount?: number;
  sawAgentEnd?: boolean;
  willRetry?: boolean;
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

/** Structured output expected from Stage 1 exploration. */
export interface Stage1Findings {
  /** One-sentence summary of what was explored. */
  summary: string;
  /** Concrete observations backed by evidence. */
  findings: Array<{
    /** File path or source anchor, if any. */
    file?: string;
    /** The observation itself. */
    observation: string;
    /** Supporting evidence (snippet, command output, value). */
    evidence?: string;
    /** Confidence in this finding. */
    confidence: "high" | "medium" | "low";
  }>;
  /** Paths or approaches that did not pan out. */
  deadEnds?: string[];
  /** Assumptions made during exploration. */
  assumptions?: string[];
  /** Questions the main agent should resolve. */
  openQuestions?: string[];
}

export function isStage1Findings(value: unknown): value is Stage1Findings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string") return false;
  if (!Array.isArray(v.findings)) return false;
  for (const f of v.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
    const finding = f as Record<string, unknown>;
    if (typeof finding.observation !== "string") return false;
    if (finding.confidence !== undefined && !["high", "medium", "low"].includes(finding.confidence as string)) return false;
  }
  return true;
}

export function emptyStage1Findings(): Stage1Findings {
  return { summary: "", findings: [] };
}

/** Structured output expected from Stage 2 synthesis. */
export interface Stage2Report {
  /** Overall status of the task. */
  status: "ok" | "needs-work" | "blocked" | "exploratory";
  /** One-paragraph summary. */
  summary: string;
  /** Key findings, decisions, or explanations. */
  output: string;
  /** Concrete anchors: paths, snippets, commands, config keys. */
  evidence: string;
  /** Reusable knowledge: dead ends, wrong assumptions, couplings. */
  learnings: string;
  /** Concrete, verifiable tasks as checkboxes. */
  actionItems: string[];
  /** 0-1 score of how well claims are grounded in the provided evidence. */
  groundingScore?: number;
  /** Claims that could not be backed by the stage 1 evidence. */
  ungroundedClaims?: string[];
}

export function isStage2Report(value: unknown): value is Stage2Report {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!["ok", "needs-work", "blocked", "exploratory"].includes(v.status as string)) return false;
  if (typeof v.summary !== "string") return false;
  if (typeof v.output !== "string") return false;
  if (typeof v.evidence !== "string") return false;
  if (typeof v.learnings !== "string") return false;
  if (!Array.isArray(v.actionItems)) return false;
  for (const item of v.actionItems) {
    if (typeof item !== "string") return false;
  }
  if (v.groundingScore !== undefined && typeof v.groundingScore !== "number") return false;
  if (v.ungroundedClaims !== undefined && !Array.isArray(v.ungroundedClaims)) return false;
  return true;
}

export function emptyStage2Report(): Stage2Report {
  return {
    status: "exploratory",
    summary: "",
    output: "",
    evidence: "",
    learnings: "",
    actionItems: [],
  };
}

/** Cost estimate for a fork before it runs. */
export interface ForkCostEstimate {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
