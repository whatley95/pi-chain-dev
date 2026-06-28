import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function handleReviewSubcommand(trimmed: string, _lower: string, _ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  const m = trimmed.match(/^reviews+(.+)$/i);
  if (_lower !== "review" && !m) return false;
  pi.sendUserMessage("Use cdev with review=true" + (m ? " for " + m[1] : ""), { triggerTurn: true, deliverAs: "steer" });
  return true;
}
