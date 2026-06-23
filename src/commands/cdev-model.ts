import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { logError } from "../extension-context.js";

export async function registerCdevModelCommand(handler: (args: string, ctx: ExtensionContext) => Promise<void> | void): Promise<void> {
  // This is a placeholder factory that returns the handler. The actual registration happens in index.ts.
  await handler("", {
    cwd: process.cwd(),
    ui: {
      theme: { fg: (_t, text) => text, bg: (_t, text) => text },
      notify: () => {},
      select: async () => undefined,
      setStatus: () => {},
      setWidget: () => {},
    },
    sessionManager: { getHeader: () => ({}), getBranch: () => [], getEntries: () => [] },
    modelRegistry: {
      getAvailable: () => [],
      getProviderAuthStatus: () => ({ configured: false }),
      hasConfiguredAuth: () => false,
    },
  });
}

export function createCdevModelHandler(): (args: string, ctx: ExtensionContext) => Promise<void> {
  return async (_args, ctx) => {
    try {
      const config = loadConfig(ctx.cwd);
      const reviewProfile = config.review ?? config.stage2;
      const stagePick = await ctx.ui.select("Pick model:", [
        `Scout A (explore)  [${config.stage1.provider || "?"}/${config.stage1.id || "?"}]`,
        `Scout B (verify)   [${config.stage1b?.provider || config.stage1.provider || "?"}/${config.stage1b?.id || config.stage1.id || "?"}]`,
        `Forge (synthesize)  [${config.stage2.provider || "?"}/${config.stage2.id || "?"}]`,
        `Review  [${reviewProfile.provider || "?"}/${reviewProfile.id || "?"}]`,
      ]);
      if (!stagePick) return;
      const stage = stagePick.startsWith("Scout A") ? "stage1"
        : stagePick.startsWith("Scout B") ? "stage1b"
        : stagePick.startsWith("Forge") ? "stage2"
        : "review";

      const allModels = typeof (ctx.modelRegistry as unknown as { getAll?: () => ReturnType<typeof ctx.modelRegistry.getAvailable> }).getAll === "function"
        ? (ctx.modelRegistry as unknown as { getAll: () => ReturnType<typeof ctx.modelRegistry.getAvailable> }).getAll()
        : ctx.modelRegistry.getAvailable();
      const configuredModels = allModels.filter(m => {
        try {
          return ctx.modelRegistry.getProviderAuthStatus(m.provider).configured;
        } catch {
          return ctx.modelRegistry.hasConfiguredAuth(m);
        }
      });
      if (configuredModels.length === 0) {
        ctx.ui.notify("Only showing models from configured providers. Use /login to add providers.", "info");
        return;
      }

      const MAX_SHOWN = 50;
      const providers = Array.from(new Set(configuredModels.map(m => m.provider)));

      function getFamily(id: string): string {
        const local = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
        const match = local.match(/^([a-z]+(?:-[a-z]+)*(?:-\d+(?:\.\d+)?[a-z]?)?)/i);
        return match ? match[1] : local;
      }

      interface PickerState {
        provider?: string;
        prefix?: string;
        family?: string;
        modelId?: string;
        thinking?: string;
      }

      function parseProvider(pick: string): string {
        const match = pick.match(/^(.+?)\s+\(/);
        return match ? match[1].trim() : pick.trim();
      }
      function parsePrefix(pick: string): string {
        const match = pick.match(/^(.+?)\/\s+\(/);
        return match ? match[1].trim() : pick.replace(/\s+\(\d+\)$/, "").trim();
      }
      function parseFamily(pick: string): string {
        const match = pick.match(/^(.+?)\s+\(/);
        return match ? match[1].trim() : pick.replace(/\s+\(\d+\)$/, "").trim();
      }
      function parseModel(pick: string): string {
        return pick.replace(/ ✓$/, "").trim();
      }

      function buildMenus(state: PickerState): Array<{
        key: keyof PickerState;
        title: string;
        items: string[];
        parse: (pick: string) => string;
      }> {
        const menus: ReturnType<typeof buildMenus> = [];
        const provider = state.provider ?? providers[0];
        const providerModels = configuredModels.filter(m => m.provider === provider);

        if (providers.length > 1) {
          menus.push({
            key: "provider",
            title: "Pick provider:",
            items: providers.map(p => `${p} (${configuredModels.filter(m => m.provider === p).length})`),
            parse: parseProvider,
          });
        }

        const prefixes = new Map<string, typeof providerModels>();
        for (const m of providerModels) {
          let prefix = m.id.includes("/") ? m.id.split("/")[0] : "(other)";
          prefix = prefix.replace(/^~+/, "");
          const list = prefixes.get(prefix);
          if (list) list.push(m);
          else prefixes.set(prefix, [m]);
        }
        const prefixEntries = Array.from(prefixes.entries())
          .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        if (providerModels.length > MAX_SHOWN && prefixEntries.length > 1) {
          menus.push({
            key: "prefix",
            title: `Pick ${provider} model group (${prefixEntries.length} groups):`,
            items: prefixEntries.map(([p, list]) => `${p}/ (${list.length})`),
            parse: parsePrefix,
          });
        }

        let shownModels = providerModels;
        if (state.prefix) {
          shownModels = prefixEntries.find(([p]) => p === state.prefix)?.[1] ?? providerModels;
        }

        const families = new Map<string, typeof shownModels>();
        for (const m of shownModels) {
          const family = getFamily(m.id);
          const list = families.get(family);
          if (list) list.push(m);
          else families.set(family, [m]);
        }
        const familyEntries = Array.from(families.entries())
          .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        if (shownModels.length > MAX_SHOWN && familyEntries.length > 1) {
          menus.push({
            key: "family",
            title: `Pick ${provider} model family (${familyEntries.length} families):`,
            items: familyEntries.map(([f, list]) => `${f} (${list.length})`),
            parse: parseFamily,
          });
        }

        if (state.family) {
          shownModels = familyEntries.find(([f]) => f === state.family)?.[1] ?? shownModels;
        }

        const currentModel = ctx.model;
        const modelItems = shownModels.slice(0, MAX_SHOWN).map(m => {
          const isCurrent = currentModel && currentModel.provider === m.provider && currentModel.id === m.id;
          return `${m.id}${isCurrent ? " ✓" : ""}`;
        });
        if (shownModels.length > MAX_SHOWN) {
          modelItems.push(`… ${shownModels.length - MAX_SHOWN} more models hidden`);
        }
        menus.push({
          key: "modelId",
          title: `Pick ${stage} model from ${provider} (${shownModels.length} available):`,
          items: modelItems,
          parse: parseModel,
        });

        menus.push({
          key: "thinking",
          title: "Pick thinking level:",
          items: ["off", "minimal", "low", "medium", "high", "xhigh"],
          parse: (pick) => pick,
        });

        return menus;
      }

      const state: PickerState = {};
      let step = 0;
      while (true) {
        const menus = buildMenus(state);
        if (step >= menus.length) break;
        const menu = menus[step];
        const pick = await ctx.ui.select(menu.title, menu.items);
        if (!pick || pick.startsWith("…")) {
          for (let i = step; i < menus.length; i++) {
            state[menus[i].key] = undefined;
          }
          if (step === 0) continue;
          step--;
          continue;
        }
        state[menu.key] = menu.parse(pick);
        step++;
      }

      const provider = state.provider ?? providers[0];
      const modelId = state.modelId;
      const thinkingPick = state.thinking;
      if (!modelId || !thinkingPick) return;

      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
      if (!settings["pi-chain-dev"]) settings["pi-chain-dev"] = {};
      (settings["pi-chain-dev"] as Record<string, unknown>)[stage] = {
        provider, id: modelId, thinking: thinkingPick,
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`Set ${stage} to ${provider}/${modelId} (${thinkingPick}). /reload to apply.`, "info");
    } catch (err) {
      logError(ctx.cwd, "cdev-model", err);
      ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };
}
