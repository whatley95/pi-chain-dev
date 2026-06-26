import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAdvisorRule, registerAdvisorPrompt } from "../src/advisor-prompt.js";

function createFakePi(): {
  handlers: Record<string, Array<(event: unknown, ctx: { cwd: string }) => unknown>>;
  on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => unknown) => void;
} {
  const handlers: Record<string, Array<(event: unknown, ctx: { cwd: string }) => unknown>> = {};
  return {
    handlers,
    on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => unknown) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
  };
}

describe("advisor-prompt", () => {
  it("returns a non-empty rule with the injection marker", () => {
    const rule = getAdvisorRule();
    assert.ok(rule.length > 0);
    assert.ok(rule.includes("pi-chain-dev:advisor-hint"));
    assert.ok(rule.includes("/cdev advisor"));
    assert.ok(rule.includes("cdev({ advisor:true"));
  });

  it("injects the advisor rule into the system prompt", () => {
    const pi = createFakePi();
    registerAdvisorPrompt(pi as never);
    const event = { systemPrompt: "existing prompt" };
    const ctx = { cwd: "/tmp" };
    const result = pi.handlers.before_agent_start?.[0]?.(event, ctx);
    assert.ok(result);
    assert.ok(typeof result === "object" && "systemPrompt" in result);
    assert.ok((result as { systemPrompt: string }).systemPrompt.includes("pi-chain-dev:advisor-hint"));
  });

  it("does not inject the rule twice", () => {
    const pi = createFakePi();
    registerAdvisorPrompt(pi as never);
    const event = { systemPrompt: "existing prompt" };
    const ctx = { cwd: "/tmp" };
    pi.handlers.before_agent_start?.[0]?.(event, ctx);
    const beforeLength = event.systemPrompt.length;
    pi.handlers.before_agent_start?.[0]?.(event, ctx);
    assert.equal(event.systemPrompt.length, beforeLength);
  });
});
