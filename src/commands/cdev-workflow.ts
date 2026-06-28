import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function handleQuickSubcommand(trimmed: string, _lower: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  if (!_lower.startsWith("quick ") && !_lower.startsWith("fast ")) return false;
  pi.sendUserMessage("Use cdev with quick=true to: " + trimmed.slice(6).trim(), { triggerTurn: true, deliverAs: "steer" });
  return true;
}
export function handleResearchSubcommand(trimmed: string, _lower: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  if (!_lower.startsWith("research ")) return false;
  pi.sendUserMessage("Use cdev with research=true to: " + trimmed.slice(9).trim(), { triggerTurn: true, deliverAs: "steer" });
  return true;
}
export function handleAdvisorSubcommand(trimmed: string, _lower: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  if (!_lower.startsWith("advisor ")) return false;
  pi.sendUserMessage("Use cdev with advisor=true to: " + trimmed.slice(8).trim(), { triggerTurn: true, deliverAs: "steer" });
  return true;
}
export function handleAskAdvisorSubcommand(trimmed: string, _lower: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  if (!_lower.startsWith("ask-advisor ")) return false;
  pi.sendUserMessage("Use cdev with advisor=true, askAdvisor=true to: " + trimmed.slice(12).trim(), { triggerTurn: true, deliverAs: "steer" });
  return true;
}
export function handleMultiSubcommand(trimmed: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  const m = trimmed.match(/^multis+(d{1,2})(?:s+(backup|no-backup))?s+(.+)$/i);
  if (!m || parseInt(m[1]) < 1 || parseInt(m[1]) > 3 || !m[3].trim()) return false;
  pi.sendUserMessage("Use cdev with parallel=" + m[1] + " to: " + m[3], { triggerTurn: true, deliverAs: "steer" });
  return true;
}
export function handlePlanSubcommand(trimmed: string, _lower: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  if (!_lower.startsWith("plan ")) return false;
  pi.sendUserMessage("Use cdev with plan=true to: " + trimmed.slice(5).trim(), { triggerTurn: true, deliverAs: "steer" });
  return true;
}
