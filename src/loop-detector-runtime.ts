/**
 * Real-time loop detection wiring.
 *
 * Maintains a sliding window of tool calls as they happen and injects a steer
 * when the parent model starts looping (e.g. re-reading the same cdev report).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectLoop, extractToolCallsFromEntries, type ToolCallRecord } from "./loop-detector.js";

const MAX_HISTORY = 24;
const LOOP_STEER_COOLDOWN_MS = 15_000;

export interface LoopDetectionState {
  recentToolCalls: ToolCallRecord[];
  lastLoopSteerAt: number;
  lastLoopSignature: string;
}

export function createLoopDetectionState(): LoopDetectionState {
  return {
    recentToolCalls: [],
    lastLoopSteerAt: 0,
    lastLoopSignature: "",
  };
}

export function recordToolCall(state: LoopDetectionState, event: unknown): void {
  const calls = extractToolCallsFromEntries([event]);
  if (calls.length === 0) return;
  state.recentToolCalls.push(...calls);
  while (state.recentToolCalls.length > MAX_HISTORY) {
    state.recentToolCalls.shift();
  }
}

export function refreshFromSessionEntries(state: LoopDetectionState, entries: unknown[]): void {
  const calls = extractToolCallsFromEntries(entries);
  state.recentToolCalls.length = 0;
  state.recentToolCalls.push(...calls.slice(-MAX_HISTORY));
}

export function checkAndSendLoopSteer(
  state: LoopDetectionState,
  sendUserMessage: (message: string, options?: Record<string, unknown>) => void,
): void {
  const loop = detectLoop(state.recentToolCalls, { threshold: 2, windowSize: 12 });
  if (!loop.looping) return;

  const signature = `${loop.repeatedTool || loop.reason}:${loop.repeatedFile || ""}`;
  const now = Date.now();
  if (signature === state.lastLoopSignature && now - state.lastLoopSteerAt < LOOP_STEER_COOLDOWN_MS) {
    return;
  }

  const message = loop.repeatedFile
    ? `LOOP DETECTED: you are re-reading the same cdev report. STOP. Read the source files it references and apply edits directly. Do not read ${loop.repeatedFile} again.`
    : `LOOP DETECTED: ${loop.reason}. STOP. ${loop.suggestion}`;
  sendUserMessage(message, { deliverAs: "steer" });
  state.lastLoopSignature = signature;
  state.lastLoopSteerAt = now;
}

export function registerRealtimeLoopDetection(pi: ExtensionAPI): LoopDetectionState {
  const state = createLoopDetectionState();

  pi.on("tool_execution_start", async (event, _ctx) => {
    try {
      recordToolCall(state, event);
      checkAndSendLoopSteer(state, (message, options) => pi.sendUserMessage(message, options));
    } catch {
      // best-effort loop detection
    }
  });

  return state;
}
