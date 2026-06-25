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
  /** Custom prompt for plan mode. */
  plan?: string;
  /** Custom prompt for review mode. */
  review?: string;
  /** Custom prompt for research mode. */
  research?: string;
}

/** Gate thresholds for deciding whether scout evidence is strong enough for forge. */
export interface ConfidenceGateConfig {
  /** Minimum number of findings required. Default 3. */
  minFindings?: number;
  /** Maximum ratio of low-confidence findings (0.0-1.0). Default 0.5. */
  maxLowConfidenceRatio?: number;
  /** Minimum number of findings with file anchors. Default 1. */
  minFileAnchors?: number;
  /** Minimum number of findings with command/output evidence. Default 1. */
  minCommandEvidence?: number;
  /** If true, gate failures trigger an automatic re-explore. Default true. */
  autoReExplore?: boolean;
}

/** Configuration stored under "pi-chain-dev" key in settings.json. */
export interface AutoForkConfig {
  /** Model profile for Stage 1 (cheap exploration). */
  stage1: StageProfile;
  /** Optional second scout model for verify mode. Falls back to stage1 if unset. */
  stage1b?: StageProfile;
  /** Optional third scout model for parallel mode. Falls back to stage1 if unset. */
  stage1c?: StageProfile;
  /** Optional backup scout that takes over failed parallel sub-tasks. Falls back to stage1 if unset. */
  stage1Backup?: StageProfile;
  /** Model profile for Stage 2 (expensive synthesis). */
  stage2: StageProfile;
  /** Optional override model for review mode. Falls back to stage2 if unset. */
  review?: StageProfile;
  /** Optional model for research mode. Falls back to stage1 if unset. */
  research?: StageProfile;
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
  /** Automatically re-explore stale topics when recalling. Default false. */
  memoryAutoRefresh?: boolean;
  /** Use theme.bg() for richer TUI rendering (progress, results). Default true. */
  themed: boolean;
  /** Run scout twice automatically for higher accuracy. */
  autoVerify: boolean;
  /** Split scout into N parallel sub-task scouts (1-3). Default 1. */
  parallel?: number;
  /** If true, a backup scout takes over failed parallel sub-tasks. Default false. */
  parallelBackup?: boolean;
  /** Max concurrent child Pi processes cdev will spawn at once. Default 3. */
  maxConcurrentStages?: number;
  /** Per-scout stage timeout in milliseconds. Default 600000 (10 minutes). */
  scoutTimeoutMs?: number;
  /** Forge/plan/review stage timeout in milliseconds. Default 180000 (3 minutes). */
  forgeTimeoutMs?: number;
  /** Per-profile timeout overrides. Keys that are omitted fall back to scoutTimeoutMs/forgeTimeoutMs. */
  profileTimeouts?: ProfileTimeoutsConfig;
  /** Model context-window limit in tokens. Default 262144. */
  modelContextLimit?: number;
  /** If true, automatically steer /compact when session snapshot exceeds model limit. Default false. */
  autoCompactOnLimit?: boolean;
  /** Characters per token used to estimate snapshot size. Default 4. Increase if cdev overestimates vs Pi's status bar. */
  tokenEstimationCharsPerToken?: number;
  /** Custom signature shown in /cdev status (e.g. name, handle). */
  signature?: string;
  /** Maximum cost (USD) for a single fork. 0 = unlimited. */
  maxForkCost?: number;
  /** Maximum total cost (USD) for cdev in the current session. 0 = unlimited. */
  maxSessionCost?: number;
  /** Confidence gate thresholds before forge runs. */
  confidenceGates?: ConfidenceGateConfig;
  /** YOLO mode: auto review → fix loops. */
  yolo?: YoloConfig;
}

export interface ProfileTimeoutsConfig {
  scout?: number;
  forge?: number;
  research?: number;
  review?: number;
  yoloReview?: number;
  yoloFix?: number;
}

/** YOLO (auto review-fix) configuration. */
export interface YoloConfig {
  /** Enable the /cdev yolo command. */
  enabled?: boolean;
  /** Maximum review-fix rounds. Default 3, hard cap 7. */
  maxRounds?: number;
  /** Stop looping when review returns pass. Default true. */
  stopOnPass?: boolean;
  /**
   * How aggressively to auto-apply fixes. Default 'manual'.
   * - manual: main agent fixes after each review (cdev never edits).
   * - propose: cdev proposes a concrete fix plan/diff; main agent applies it.
   * - auto: cdev may edit files directly between review rounds.
   */
  autoApply?: "manual" | "propose" | "auto";
  /** Model profile for yolo review rounds. Falls back to stage2. */
  reviewProfile?: StageProfile;
  /** Model profile for yolo fix/propose rounds. Falls back to stage2. */
  fixProfile?: StageProfile;
}

export function normalizeYoloConfig(config?: YoloConfig): Required<Omit<YoloConfig, "reviewProfile" | "fixProfile">> & Pick<YoloConfig, "reviewProfile" | "fixProfile"> {
  const max = config?.maxRounds ?? 3;
  return {
    enabled: config?.enabled ?? false,
    maxRounds: max > 7 ? 7 : max < 1 ? 1 : max,
    stopOnPass: config?.stopOnPass ?? true,
    autoApply: config?.autoApply ?? "manual",
    reviewProfile: config?.reviewProfile,
    fixProfile: config?.fixProfile,
  };
}

export function formatYoloStatus(config?: YoloConfig): string {
  const normalized = normalizeYoloConfig(config);
  if (!normalized.enabled) return "OFF";
  return `ON (max ${normalized.maxRounds} rounds, auto-apply ${normalized.autoApply})`;
}

export function normalizeConfidenceGates(config?: ConfidenceGateConfig): Required<ConfidenceGateConfig> {
  return {
    minFindings: Math.max(0, config?.minFindings ?? 3),
    maxLowConfidenceRatio: Math.min(1, Math.max(0, config?.maxLowConfidenceRatio ?? 0.5)),
    minFileAnchors: Math.max(0, config?.minFileAnchors ?? 1),
    minCommandEvidence: Math.max(0, config?.minCommandEvidence ?? 1),
    autoReExplore: config?.autoReExplore ?? true,
  };
}

export function evaluateConfidenceGates(findings: Stage1Findings, gates?: ConfidenceGateConfig): { passed: boolean; reasons: string[] } {
  const g = normalizeConfidenceGates(gates);
  const reasons: string[] = [];
  if (findings.findings.length < g.minFindings) {
    reasons.push(`only ${findings.findings.length} finding(s) (min ${g.minFindings})`);
  }
  const lowCount = findings.findings.filter((f) => f.confidence === "low").length;
  const lowRatio = findings.findings.length > 0 ? lowCount / findings.findings.length : 0;
  if (lowRatio > g.maxLowConfidenceRatio) {
    reasons.push(`${Math.round(lowRatio * 100)}% low confidence (max ${Math.round(g.maxLowConfidenceRatio * 100)}%)`);
  }
  const fileAnchors = new Set(findings.findings.map((f) => f.file).filter(Boolean)).size;
  if (fileAnchors < g.minFileAnchors) {
    reasons.push(`${fileAnchors} file anchor(s) (min ${g.minFileAnchors})`);
  }
  const commandEvidence = findings.findings.filter((f) => f.evidence && /\$\s*\w+|`[^`]+`|output|stdout|stderr|command/i.test(f.evidence)).length;
  if (commandEvidence < g.minCommandEvidence) {
    reasons.push(`${commandEvidence} command evidence item(s) (min ${g.minCommandEvidence})`);
  }
  return { passed: reasons.length === 0, reasons };
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
  /** Wall-clock duration of this stage/run in milliseconds. */
  durationMs?: number;
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
  stage1b?: ForkResult | null;
  stage1c?: ForkResult | null;
  stage1Backup?: ForkResult | null;
  stage2: ForkResult | null;
  /** Research output expected from /cdev research. */
  research?: Stage1Findings | null;
  /** Cost of the research stage, when research mode is used. */
  researchCost?: number;
  /** Set when autoCompactOnLimit triggered and the tool refused to run. */
  autoCompact?: { tokens: number; limit: number } | null;
  ui?: AutoForkUiDetails;
}

export type CdevUiMode = "fork" | "quick" | "verify" | "plan" | "review" | "yolo" | "recall" | "parallel" | "research";

export interface AutoForkUiDetails {
  mode?: CdevUiMode;
  task?: string;
  reportPath?: string;
  status?: Stage2Report["status"] | PlanReport["status"];
  groundingScore?: number;
  qualityScore?: number;
  ungroundedClaimCount?: number;
  actionItemCount?: number;
  coverage?: SourceCoverageStats;
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
  /** Prompt version used to produce this finding. */
  promptVersion?: string;
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
  /** Coverage statistics collected during exploration. */
  coverage?: SourceCoverageStats;
  /** Contradictions found between multiple scout runs. */
  contradictions?: FindingContradiction[];
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
    if (finding.file !== undefined && typeof finding.file !== "string") return false;
    if (finding.evidence !== undefined && typeof finding.evidence !== "string") return false;
  }
  if (v.deadEnds !== undefined && (!Array.isArray(v.deadEnds) || !v.deadEnds.every((item) => typeof item === "string"))) return false;
  if (v.assumptions !== undefined && (!Array.isArray(v.assumptions) || !v.assumptions.every((item) => typeof item === "string"))) return false;
  if (v.openQuestions !== undefined && (!Array.isArray(v.openQuestions) || !v.openQuestions.every((item) => typeof item === "string"))) return false;
  if (v.coverage !== undefined && !isSourceCoverageStats(v.coverage)) return false;
  if (v.contradictions !== undefined && (!Array.isArray(v.contradictions) || !v.contradictions.every(isFindingContradiction))) return false;
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
  /** Coverage statistics collected by the scout stage. */
  coverage?: SourceCoverageStats;
  /** Report quality score (evidence density, actionability, etc.). */
  qualityScore?: number;
  /** Human-readable quality assessment. */
  qualityNotes?: string;
}

/** Coverage statistics for a scout/run. */
export interface SourceCoverageStats {
  filesInspected: number;
  filesCited: number;
  commandsRun: number;
  unreadLikelyFiles?: number;
}

/** Contradiction between two scout findings. */
export interface FindingContradiction {
  observationA: string;
  observationB: string;
  summary: string;
}

/** Structured output expected from plan mode. */
export interface PlanReport {
  /** Overall status of the plan. */
  status: "ok" | "needs-work" | "blocked" | "exploratory";
  /** One-paragraph plan summary. */
  summary: string;
  /** Concrete implementation risks and mitigations. */
  risks: string[];
  /** File sets relevant to implementation. */
  files: {
    read: string[];
    toModify: string[];
    toCreate: string[];
  };
  /** Ordered implementation steps. */
  steps: Array<{
    order: number;
    description: string;
    verification: string;
  }>;
  /** Ordered, executable checklist for the main agent. */
  checklist: Array<{
    order: number;
    task: string;
    verification: string;
    grounded: boolean;
  }>;
  /** Commands to run after implementation. */
  testCommands: string[];
  /** Questions the main agent/user should resolve before editing. */
  openQuestions?: string[];
  /** 0-1 score of how well plan claims are grounded in scout evidence. */
  groundingScore?: number;
  /** Claims not backed by scout evidence. */
  ungroundedClaims?: string[];
  /** Coverage statistics collected by the scout stage. */
  coverage?: SourceCoverageStats;
  /** Plan quality score. */
  qualityScore?: number;
  /** Human-readable quality assessment. */
  qualityNotes?: string;
}

function isSourceCoverageStats(value: unknown): value is SourceCoverageStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  for (const key of ["filesInspected", "filesCited", "commandsRun"] as const) {
    if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] < 0) return false;
  }
  if (v.unreadLikelyFiles !== undefined && (typeof v.unreadLikelyFiles !== "number" || !Number.isFinite(v.unreadLikelyFiles) || v.unreadLikelyFiles < 0)) {
    return false;
  }
  return true;
}

function isFindingContradiction(value: unknown): value is FindingContradiction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.observationA === "string"
    && typeof v.observationB === "string"
    && typeof v.summary === "string";
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
  if (v.groundingScore !== undefined && (typeof v.groundingScore !== "number" || !Number.isFinite(v.groundingScore) || v.groundingScore < 0 || v.groundingScore > 1)) return false;
  if (v.ungroundedClaims !== undefined && !Array.isArray(v.ungroundedClaims)) return false;
  if (v.ungroundedClaims !== undefined && !v.ungroundedClaims.every((claim) => typeof claim === "string")) return false;
  if (v.qualityScore !== undefined && (typeof v.qualityScore !== "number" || !Number.isFinite(v.qualityScore) || v.qualityScore < 0 || v.qualityScore > 1)) return false;
  if (v.qualityNotes !== undefined && typeof v.qualityNotes !== "string") return false;
  if (v.coverage !== undefined && !isSourceCoverageStats(v.coverage)) return false;
  return true;
}

export function isPlanReport(value: unknown): value is PlanReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!["ok", "needs-work", "blocked", "exploratory"].includes(v.status as string)) return false;
  if (typeof v.summary !== "string") return false;
  if (!Array.isArray(v.risks) || !v.risks.every((risk) => typeof risk === "string")) return false;
  if (!v.files || typeof v.files !== "object" || Array.isArray(v.files)) return false;
  const files = v.files as Record<string, unknown>;
  for (const key of ["read", "toModify", "toCreate"] as const) {
    if (!Array.isArray(files[key]) || !(files[key] as unknown[]).every((file) => typeof file === "string")) return false;
  }
  if (!Array.isArray(v.steps)) return false;
  for (const step of v.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return false;
    const s = step as Record<string, unknown>;
    if (typeof s.order !== "number" || !Number.isFinite(s.order)) return false;
    if (typeof s.description !== "string") return false;
    if (typeof s.verification !== "string") return false;
  }
  if (!Array.isArray(v.checklist)) return false;
  for (const item of v.checklist) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const c = item as Record<string, unknown>;
    if (typeof c.order !== "number" || !Number.isFinite(c.order)) return false;
    if (typeof c.task !== "string") return false;
    if (typeof c.verification !== "string") return false;
    if (typeof c.grounded !== "boolean") return false;
  }
  if (!Array.isArray(v.testCommands) || !v.testCommands.every((command) => typeof command === "string")) return false;
  if (v.openQuestions !== undefined && (!Array.isArray(v.openQuestions) || !v.openQuestions.every((question) => typeof question === "string"))) return false;
  if (v.groundingScore !== undefined && (typeof v.groundingScore !== "number" || !Number.isFinite(v.groundingScore) || v.groundingScore < 0 || v.groundingScore > 1)) return false;
  if (v.ungroundedClaims !== undefined && (!Array.isArray(v.ungroundedClaims) || !v.ungroundedClaims.every((claim) => typeof claim === "string"))) return false;
  if (v.coverage !== undefined && !isSourceCoverageStats(v.coverage)) return false;
  if (v.qualityScore !== undefined && (typeof v.qualityScore !== "number" || !Number.isFinite(v.qualityScore) || v.qualityScore < 0 || v.qualityScore > 1)) return false;
  if (v.qualityNotes !== undefined && typeof v.qualityNotes !== "string") return false;
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
