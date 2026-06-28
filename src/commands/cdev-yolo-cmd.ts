import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAgentSetting } from "../settings-helpers.js";

export function handleYoloSubcommand(trimmed: string, lower: string, ctx: ExtensionContext, pi: ExtensionAPI): boolean {
  if (lower === "yolo on" || lower === "yolo off") {
    writeAgentSetting("yolo", { enabled: lower === "yolo on" });
    ctx.ui.notify("cdev yolo mode " + (lower === "yolo on" ? "ON" : "OFF"), "info");
    return true;
  }
  if (/^yolos+(manual|propose|auto)$/i.test(trimmed)) {
    ctx.ui.notify("cdev yolo auto-apply set", "info");
    return true;
  }
  if (lower === "yolo") { ctx.ui.notify("Usage", "info"); return true; }
  if (lower.startsWith("yolo ")) {
    const t = trimmed.slice(5).trim(); if (!t) return false;
    pi.sendUserMessage("Use cdev with yolo=true to: " + t, { triggerTurn: true, deliverAs: "steer" });
    return true;
  }
  return false;
}
