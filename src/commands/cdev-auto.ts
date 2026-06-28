import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAgentSetting } from "../settings-helpers.js";

export function handleAutoSubcommand(
  lower: string,
  ctx: ExtensionContext,
  resetAutoTurnCounter: () => void,
  updateAutoStatus: (ctx: ExtensionContext) => void,
): boolean {
  if (lower === "auto on" || lower === "auto") {
    writeAgentSetting("auto", true);
    ctx.ui.notify("cdev auto mode ON", "info");
    resetAutoTurnCounter(); updateAutoStatus(ctx);
    return true;
  }
  if (lower === "auto off") {
    writeAgentSetting("auto", false);
    ctx.ui.notify("cdev auto mode OFF", "info");
    resetAutoTurnCounter(); updateAutoStatus(ctx);
    return true;
  }
  if (lower === "auto-verify on" || lower === "auto-verify off") {
    writeAgentSetting("autoVerify", lower === "auto-verify on");
    ctx.ui.notify("cdev auto-verify " + (lower === "auto-verify on" ? "ON" : "OFF"), "info");
    return true;
  }
  if (lower === "auto-compact on" || lower === "auto-compact off") {
    writeAgentSetting("autoCompactOnLimit", lower === "auto-compact on");
    ctx.ui.notify("cdev auto-compact " + (lower === "auto-compact on" ? "ON" : "OFF"), "info");
    return true;
  }
  return false;
}
