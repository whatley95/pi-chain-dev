import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoForkConfig } from "../config.js";
import { runAutoFork } from "../fork-orchestrator.js";
import { getFinalAssistantText } from "../runner-events.js";
import { saveSession } from "../history.js";
import { indexFindingsAsync } from "../memory.js";
import {
  withAuditGuard,
  makeThemedBg,
  buildSessionSnapshotJsonl,
  resolveStageProfiles,
  logError,
} from "../extension-context.js";
import {
  generateProjectMap,
  loadProjectMap,
  saveProjectMap,
  formatMapReport,
  summarizeMapForPrompt,
  getMapPath,
} from "../project-map.js";
import type { MapDir, MapModule, MapBoundary } from "../project-map.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const MAP_GENERATION_TASK = `You are generating a structured project map for this codebase.

First, read the existing template map below (if present). Then explore the actual codebase to refine, correct, and expand it.

Your output MUST be a single YAML document matching this structure:

project:
  name: "project name"
  type: "flutter-mobile | spring-boot-backend | node-backend | web-frontend | fullstack-web | python-backend | go-backend | rust-cli | generic"
  language: "primary language"
  languages: ["Dart", "Java", ...]
  entryPoints: ["lib/main.dart", "src/main/java/.../Application.java"]
stack:
  framework: ["Flutter"]
  backend: []
  frontend: []
  mobile: ["Flutter"]
  orm: []
  auth: []
  testing: ["flutter_test"]
  validation: []
  styling: []
  build: []
  stateManagement: []
  packageManager: ["pub"]
  db: []
  monorepo: []
structure:
  rootDirs: []
  sourceRoots: ["lib"]
  testRoots: ["test"]
  configFiles: ["pubspec.yaml"]
  importantFiles: []
  generatedDirs: [".dart_tool", "build"]
  dirs:
    - path: "lib"
      depth: 0
      fileCount: 0
      dirCount: 0
  modules: []
  boundaries:
    - name: "presentation"
      globs: ["lib/**/widgets/", "lib/**/screens/"]
      type: "layer"
  nestingDepth: 0
  fileCountsByExtension:
    ".dart": 0
conventions:
  folderStructure: "describe folder conventions"
  naming: "describe naming conventions"
  stateManagement: "describe state conventions"
  errorHandling: "describe error handling conventions"
  testing: "describe testing conventions"
  layering: "describe architecture layering"
config:
  envFiles: []
  buildCommands: ["flutter build apk"]
  testCommands: ["flutter test"]
  runCommands: ["flutter run"]
  lintCommands: ["flutter analyze"]
architecture:
  patterns: ["Layered architecture", "Widget tree"]
  layers:
    presentation: ["lib/**/widgets/"]
    domain: ["lib/**/models/"]
    data: ["lib/**/repositories/"]
notes:
  - "Any useful note for scouts"

Rules:
- Preserve fields that already look correct; fix only wrong or missing ones.
- Be concise. Use glob patterns where helpful.
- Do NOT include prose outside the YAML document.
- If you cannot determine a value, use an empty array or omit optional string fields.`;

function parseGeneratedYaml(text: string): unknown {
  const match = text.match(/```yaml\s*\n([\s\S]*?)\n```/) || text.match(/```\s*\n([\s\S]*?)\n```/);
  const yamlText = match?.[1]?.trim() || text.trim();
  try {
    return parseYaml(yamlText);
  } catch {
    return null;
  }
}

function mergeMaps(base: ReturnType<typeof generateProjectMap>, generated: unknown): ReturnType<typeof generateProjectMap> {
  if (!generated || typeof generated !== "object") return base;
  const g = generated as Record<string, unknown>;

  function pick(obj: unknown, key: string): unknown {
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
  }

  function str(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
  }

  function arr(value: unknown, fallback?: string[]): string[] {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return fallback ?? [];
    return value.length > 0 ? value : (fallback ?? []);
  }

  function record(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) && v.every((item) => typeof item === "string")) result[k] = v;
    }
    return result;
  }

  function mapDir(value: unknown): MapDir[] {
    if (!Array.isArray(value)) return [];
    const result: MapDir[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.path !== "string") continue;
      result.push({
        path: obj.path,
        depth: typeof obj.depth === "number" ? obj.depth : 0,
        fileCount: typeof obj.fileCount === "number" ? obj.fileCount : 0,
        dirCount: typeof obj.dirCount === "number" ? obj.dirCount : 0,
      });
    }
    return result;
  }

  function mapModule(value: unknown): MapModule[] {
    if (!Array.isArray(value)) return [];
    const result: MapModule[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== "string" || typeof obj.path !== "string") continue;
      result.push({
        name: obj.name,
        path: obj.path,
        layer: typeof obj.layer === "string" ? obj.layer : undefined,
      });
    }
    return result;
  }

  function mapBoundary(value: unknown): MapBoundary[] {
    if (!Array.isArray(value)) return [];
    const result: MapBoundary[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== "string" || !Array.isArray(obj.globs)) continue;
      const type = obj.type === "layer" || obj.type === "feature" || obj.type === "domain" ? obj.type : "layer";
      result.push({ name: obj.name, globs: obj.globs.filter((g): g is string => typeof g === "string"), type });
    }
    return result;
  }

  function fileCounts(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number") result[k] = v;
    }
    return result;
  }

  function num(value: unknown, fallback: number): number {
    return typeof value === "number" ? value : fallback;
  }

  const gProject = pick(g, "project") as Record<string, unknown> | undefined;
  const gStack = pick(g, "stack") as Record<string, unknown> | undefined;
  const gStructure = pick(g, "structure") as Record<string, unknown> | undefined;
  const gConventions = pick(g, "conventions") as Record<string, unknown> | undefined;
  const gConfig = pick(g, "config") as Record<string, unknown> | undefined;
  const gArchitecture = pick(g, "architecture") as Record<string, unknown> | undefined;
  const gNotes = pick(g, "notes");

  const mergedConventions: typeof base.conventions = { ...base.conventions };
  if (gConventions) {
    for (const [key, value] of Object.entries(gConventions)) {
      if (typeof value === "string") mergedConventions[key] = value;
    }
  }

  return {
    ...base,
    project: {
      ...base.project,
      name: str(gProject?.name, base.project.name),
      type: str(gProject?.type, base.project.type),
      language: str(gProject?.language, base.project.language),
      languages: arr(gProject?.languages, base.project.languages),
      entryPoints: arr(gProject?.entryPoints, base.project.entryPoints),
    },
    stack: {
      ...base.stack,
      framework: arr(gStack?.framework, base.stack.framework),
      backend: arr(gStack?.backend, base.stack.backend),
      frontend: arr(gStack?.frontend, base.stack.frontend),
      mobile: arr(gStack?.mobile, base.stack.mobile),
      orm: arr(gStack?.orm, base.stack.orm),
      auth: arr(gStack?.auth, base.stack.auth),
      testing: arr(gStack?.testing, base.stack.testing),
      validation: arr(gStack?.validation, base.stack.validation),
      styling: arr(gStack?.styling, base.stack.styling),
      build: arr(gStack?.build, base.stack.build),
      stateManagement: arr(gStack?.stateManagement, base.stack.stateManagement),
      packageManager: arr(gStack?.packageManager, base.stack.packageManager),
      db: arr(gStack?.db, base.stack.db),
      monorepo: arr(gStack?.monorepo, base.stack.monorepo),
    },
    structure: {
      rootDirs: arr(gStructure?.rootDirs, base.structure.rootDirs),
      sourceRoots: arr(gStructure?.sourceRoots, base.structure.sourceRoots),
      testRoots: arr(gStructure?.testRoots, base.structure.testRoots),
      configFiles: arr(gStructure?.configFiles, base.structure.configFiles),
      importantFiles: arr(gStructure?.importantFiles, base.structure.importantFiles),
      generatedDirs: arr(gStructure?.generatedDirs, base.structure.generatedDirs),
      dirs: mapDir(gStructure?.dirs).length ? mapDir(gStructure?.dirs) : base.structure.dirs,
      modules: mapModule(gStructure?.modules).length ? mapModule(gStructure?.modules) : base.structure.modules,
      boundaries: mapBoundary(gStructure?.boundaries).length ? mapBoundary(gStructure?.boundaries) : base.structure.boundaries,
      nestingDepth: num(gStructure?.nestingDepth, base.structure.nestingDepth),
      fileCountsByExtension: Object.keys(fileCounts(gStructure?.fileCountsByExtension)).length
        ? { ...base.structure.fileCountsByExtension, ...fileCounts(gStructure?.fileCountsByExtension) }
        : base.structure.fileCountsByExtension,
    },
    conventions: mergedConventions,
    config: {
      envFiles: arr(gConfig?.envFiles).length ? arr(gConfig?.envFiles) : base.config.envFiles,
      buildCommands: arr(gConfig?.buildCommands).length ? arr(gConfig?.buildCommands) : base.config.buildCommands,
      testCommands: arr(gConfig?.testCommands).length ? arr(gConfig?.testCommands) : base.config.testCommands,
      runCommands: arr(gConfig?.runCommands).length ? arr(gConfig?.runCommands) : base.config.runCommands,
      lintCommands: arr(gConfig?.lintCommands).length ? arr(gConfig?.lintCommands) : base.config.lintCommands,
    },
    architecture: {
      patterns: arr(gArchitecture?.patterns).length ? arr(gArchitecture?.patterns) : base.architecture.patterns,
      layers: record(gArchitecture?.layers).length ? { ...base.architecture.layers, ...record(gArchitecture?.layers) } : base.architecture.layers,
    },
    notes: Array.isArray(gNotes) && gNotes.length && gNotes.every((n) => typeof n === "string")
      ? [...base.notes, ...gNotes]
      : base.notes,
    generatedAt: new Date().toISOString(),
    generatedBy: "cdev scout+forge map generator",
  };
}

export async function handleMap(args: string, ctx: ExtensionContext, config: AutoForkConfig): Promise<boolean> {
  const trimmed = args.trim();

  if (trimmed === "map" || trimmed === "map refresh") {
    const profiles = resolveStageProfiles(config);
    const themedBg = makeThemedBg(ctx, config.themed);
    if (profiles.warning) {
      ctx.ui.notify(profiles.warning, "warn");
      return true;
    }

    const isRefresh = trimmed === "map refresh";
    ctx.ui.notify(isRefresh ? "Refreshing project map via scout+forge..." : "Generating project map via scout+forge...", "info");

    try {
      const snapshot = buildSessionSnapshotJsonl(ctx.sessionManager, config.modelContextLimit);
      if (!snapshot) {
        ctx.ui.notify("Cannot snapshot session.", "error");
        return true;
      }

      const existingMap = loadProjectMap(ctx.cwd);
      const baseMap = existingMap || generateProjectMap(ctx.cwd);
      const existingYaml = stringifyYaml(baseMap, { indent: 2, lineWidth: 0 });
      const task = `${MAP_GENERATION_TASK}\n\nExisting template map:\n\n${existingYaml}`;

      const startTime = Date.now();
      const onProgress = (stage: string, model: string) => {
        const icon = stage === "scout" ? "🔍" : "⚒️";
        ctx.ui.setWidget("cdev-progress", [themedBg("toolPendingBg", `${icon} ${stage === "scout" ? "Scout" : "Forge"} mapping project…  (${model})`)]);
      };
      onProgress("scout", profiles.stage1.id);

      const { result, details } = await runAutoFork({
        cwd: ctx.cwd,
        task: withAuditGuard(task),
        forkSessionSnapshotJsonl: snapshot,
        stage1Profile: profiles.stage1,
        stage2Profile: profiles.stage2,
        scoutTimeoutMs: config.profileTimeouts?.scout ?? config.scoutTimeoutMs,
        forgeTimeoutMs: config.profileTimeouts?.forge ?? config.forgeTimeoutMs,
        onProgress,
        extensions: config.extensions,
        environment: config.environment,
        offline: config.offline,
        signal: undefined,
      });
      ctx.ui.setWidget("cdev-progress", undefined);

      saveSession(ctx.cwd, isRefresh ? "cdev map refresh" : "cdev map", false, startTime, details, result);
      if (result.errorMessage) logError(ctx.cwd, "map-generation", new Error(result.errorMessage));
      if (config.memory) {
        indexFindingsAsync({
          task: isRefresh ? "cdev map refresh" : "cdev map",
          resultText: getFinalAssistantText(result.messages) || "",
          stage1Model: details.stage1?.model ?? profiles.stage1.id,
          stage2Model: details.stage2?.model ?? profiles.stage2.id,
          isReview: false,
          quick: false,
          cost: result.usage?.cost ?? 0,
          cwd: ctx.cwd,
        });
      }

      const text = getFinalAssistantText(result.messages) || "";
      const generated = parseGeneratedYaml(text);
      const merged = mergeMaps(generateProjectMap(ctx.cwd), generated);
      saveProjectMap(ctx.cwd, merged);

      ctx.ui.notify(formatMapReport(merged), "info");
    } catch (err) {
      logError(ctx.cwd, "map-command", err);
      ctx.ui.notify(`Map generation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return true;
  }

  if (trimmed === "map show" || trimmed === "map view") {
    const map = loadProjectMap(ctx.cwd);
    if (!map) {
      ctx.ui.notify("No project map found. Run `/cdev map` to generate one.", "warn");
      return true;
    }
    const yaml = stringifyYaml(map, { indent: 2, lineWidth: 0 });
    ctx.ui.notify(`── cdev project map (.pi/cdev/map.yaml) ──────────────\n\n${yaml}`, "info");
    return true;
  }

  if (trimmed.startsWith("map ")) {
    ctx.ui.notify("Usage:\n/cdev map            Generate project map\n/cdev map refresh    Regenerate via scout+forge\n/cdev map show       View existing map", "info");
    return true;
  }

  return false;
}

export { summarizeMapForPrompt, getMapPath, loadProjectMap };