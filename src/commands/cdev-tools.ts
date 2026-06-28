import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function handleReadSubcommand(trimmed: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  const m = trimmed.match(/^reads+(.+)$/i); if (!m) return false;
  pi.sendUserMessage("Use cdev with quick=true to read: " + m[1], { triggerTurn: true, deliverAs: "steer" });
  return true;
}

export function handleGrepSubcommand(trimmed: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  const m = trimmed.match(/^greps+(.+)$/i); if (!m) return false;
  pi.sendUserMessage("Use cdev with quick=true to grep: " + m[1], { triggerTurn: true, deliverAs: "steer" });
  return true;
}

export function handleTraceSubcommand(trimmed: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  const m = trimmed.match(/^traces+(.+)$/i); if (!m) return false;
  pi.sendUserMessage("Use cdev with quick=true to trace: " + m[1], { triggerTurn: true, deliverAs: "steer" });
  return true;
}

export function handleExplainSubcommand(trimmed: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  const m = trimmed.match(/^explains+(.+)$/i); if (!m) return false;
  pi.sendUserMessage("Use cdev with quick=true to explain: " + m[1], { triggerTurn: true, deliverAs: "steer" });
  return true;
}
