/**
 * /cdev map — project map generator and loader.
 *
 * Produces a stack-agnostic `.pi/cdev/map.yaml` that captures project
 * structure, conventions, entry points, and useful context for scouts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ProjectMap {
  project: {
    name: string;
    type: string;
    language: string;
    languages: string[];
    entryPoints: string[];
    description?: string;
  };
  stack: {
    framework: string[];
    backend: string[];
    frontend: string[];
    mobile: string[];
    orm: string[];
    auth: string[];
    testing: string[];
    validation: string[];
    styling: string[];
    build: string[];
    stateManagement: string[];
    packageManager: string[];
    db: string[];
    monorepo: string[];
    [key: string]: string[];
  };
  structure: {
    rootDirs: string[];
    sourceRoots: string[];
    testRoots: string[];
    configFiles: string[];
    importantFiles: string[];
  };
  conventions: {
    folderStructure?: string;
    naming?: string;
    stateManagement?: string;
    errorHandling?: string;
    testing?: string;
    layering?: string;
    [key: string]: string | undefined;
  };
  config: {
    envFiles: string[];
    buildCommands: string[];
    testCommands: string[];
    runCommands: string[];
    lintCommands: string[];
    [key: string]: string[];
  };
  architecture: {
    patterns: string[];
    layers?: Record<string, string[]>;
    boundaries?: string[];
    [key: string]: unknown;
  };
  dependencies: Record<string, string[]>;
  files: {
    tree: string[];
    keyFiles: string[];
  };
  routes?: Record<string, string[]>;
  workspaces?: { packages: string[] };
  notes: string[];
  generatedAt: string;
  generatedBy: string;
}

export const MAP_PATH = [".pi", "cdev", "map.yaml"];

export function getMapPath(cwd: string): string {
  return join(cwd, ...MAP_PATH);
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function tryReadText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function detectPackageManagers(cwd: string): string[] {
  const found: string[] = [];
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) found.push("pnpm");
  if (existsSync(join(cwd, "yarn.lock"))) found.push("yarn");
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) found.push("bun");
  if (existsSync(join(cwd, "package-lock.json"))) found.push("npm");
  if (existsSync(join(cwd, "pubspec.lock"))) found.push("pub");
  if (existsSync(join(cwd, "pubspec.yaml"))) found.push("pub");
  if (existsSync(join(cwd, "pom.xml"))) found.push("maven");
  if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) found.push("gradle");
  if (existsSync(join(cwd, "requirements.txt"))) found.push("pip");
  if (existsSync(join(cwd, "pyproject.toml"))) found.push("poetry");
  if (existsSync(join(cwd, "go.mod"))) found.push("go mod");
  if (existsSync(join(cwd, "Cargo.toml"))) found.push("cargo");
  if (existsSync(join(cwd, "Gemfile"))) found.push("bundler");
  if (existsSync(join(cwd, "composer.json"))) found.push("composer");
  return Array.from(new Set(found));
}

function detectLanguages(cwd: string): string[] {
  const found: string[] = [];
  if (existsSync(join(cwd, "pubspec.yaml"))) found.push("Dart");
  if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) found.push("Java");
  if (existsSync(join(cwd, "build.gradle.kts"))) found.push("Kotlin");
  if (existsSync(join(cwd, "src")) && globCount(cwd, "*.kt") > 0) found.push("Kotlin");
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml"))) found.push("Python");
  if (existsSync(join(cwd, "go.mod"))) found.push("Go");
  if (existsSync(join(cwd, "Cargo.toml"))) found.push("Rust");
  if (existsSync(join(cwd, "Gemfile"))) found.push("Ruby");
  if (existsSync(join(cwd, "composer.json"))) found.push("PHP");
  if (existsSync(join(cwd, "tsconfig.json"))) found.push("TypeScript");
  else if (globCount(cwd, "*.js") > 0 || existsSync(join(cwd, "package.json"))) found.push("JavaScript");
  if (globCount(cwd, "*.swift") > 0) found.push("Swift");
  if (globCount(cwd, "*.cs") > 0 || globCount(cwd, "*.csproj") > 0) found.push("C#");
  if (globCount(cwd, "*.cpp") > 0 || globCount(cwd, "*.hpp") > 0) found.push("C++");
  if (globCount(cwd, "*.c") > 0 && !found.includes("C++")) found.push("C");
  return Array.from(new Set(found));
}

function globCount(cwd: string, pattern: string): number {
  try {
    let count = 0;
    function walk(dir: string, depth: number): void {
      if (depth > 3) return;
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git" || entry === ".pi" || entry === "dist" || entry === "build") continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else if (entry.endsWith(pattern.replace("*.", "."))) count++;
      }
    }
    walk(cwd, 0);
    return count;
  } catch {
    return 0;
  }
}

function detectEntryPoints(cwd: string, languages: string[]): string[] {
  const candidates: string[] = [];

  const checks: Record<string, string[]> = {
    Dart: ["lib/main.dart"],
    Java: ["src/main/java/Application.java", "src/main/java/com/example/Application.java"],
    Kotlin: ["src/main/kotlin/Application.kt", "src/main/kotlin/com/example/Application.kt"],
    Python: ["main.py", "app.py", "manage.py", "src/__init__.py"],
    Go: ["main.go", "cmd/main.go"],
    Rust: ["src/main.rs"],
    Ruby: ["config.ru", "app.rb"],
    PHP: ["public/index.php", "index.php"],
    TypeScript: ["src/index.ts", "src/main.ts", "index.ts"],
    JavaScript: ["src/index.js", "src/main.js", "index.js"],
    Swift: ["Sources/main.swift"],
    "C#": ["Program.cs", "src/Program.cs"],
  };

  for (const lang of languages) {
    for (const check of checks[lang] ?? []) {
      if (existsSync(join(cwd, check))) candidates.push(check);
    }
  }

  return candidates;
}

function detectSourceRoots(cwd: string, languages: string[]): string[] {
  const roots: string[] = [];
  if (existsSync(join(cwd, "lib")) && languages.includes("Dart")) roots.push("lib");
  if (existsSync(join(cwd, "src"))) roots.push("src");
  if (existsSync(join(cwd, "app"))) roots.push("app");
  if (existsSync(join(cwd, "Sources"))) roots.push("Sources");
  if (existsSync(join(cwd, "cmd"))) roots.push("cmd");
  return roots;
}

function detectTestRoots(cwd: string): string[] {
  const roots: string[] = [];
  if (existsSync(join(cwd, "test"))) roots.push("test");
  if (existsSync(join(cwd, "tests"))) roots.push("tests");
  if (existsSync(join(cwd, "__tests__"))) roots.push("__tests__");
  if (existsSync(join(cwd, "src", "test"))) roots.push("src/test");
  if (existsSync(join(cwd, "src", "tests"))) roots.push("src/tests");
  return roots;
}

function detectConfigFiles(cwd: string): string[] {
  const files: string[] = [];
  const candidates = [
    "package.json", "tsconfig.json", "jsconfig.json", "pubspec.yaml", "pom.xml",
    "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile",
    "composer.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    ".env", ".env.example", ".gitignore", "Makefile", "README.md",
  ];
  for (const file of candidates) {
    if (existsSync(join(cwd, file))) files.push(file);
  }
  return files;
}

function detectRootDirs(cwd: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of readdirSync(cwd)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(cwd, entry);
      if (statSync(full).isDirectory()) dirs.push(entry);
    }
  } catch { /* ignore */ }
  return dirs.slice(0, 30);
}

function detectEnvFiles(cwd: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(cwd)) {
      if (entry.startsWith(".env")) files.push(entry);
    }
  } catch { /* ignore */ }
  return files;
}

function detectCommands(cwd: string, pkgManager: string[], languages: string[]): {
  build: string[];
  test: string[];
  run: string[];
  lint: string[];
  [key: string]: string[];
} {
  const build: string[] = [];
  const test: string[] = [];
  const run: string[] = [];
  const lint: string[] = [];
  const pkgJson = readJsonSafe(join(cwd, "package.json"));
  const scripts = (pkgJson?.scripts as Record<string, string>) || {};

  if (pkgManager.includes("npm") || pkgManager.includes("pnpm") || pkgManager.includes("yarn") || pkgManager.includes("bun")) {
    if (scripts.build) build.push("npm run build");
    if (scripts.test) test.push("npm test");
    if (scripts.start) run.push("npm start");
    if (scripts.lint) lint.push("npm run lint");
  }

  if (languages.includes("Dart")) {
    build.push("flutter build apk");
    test.push("flutter test");
    run.push("flutter run");
    lint.push("flutter analyze");
  }

  if (languages.includes("Java") || languages.includes("Kotlin")) {
    build.push("./gradlew build");
    test.push("./gradlew test");
    run.push("./gradlew bootRun");
    lint.push("./gradlew check");
  }

  if (languages.includes("Python")) {
    test.push("pytest");
    lint.push("ruff check .");
  }

  if (languages.includes("Go")) {
    build.push("go build ./...");
    test.push("go test ./...");
    lint.push("go vet ./...");
  }

  if (languages.includes("Rust")) {
    build.push("cargo build");
    test.push("cargo test");
    lint.push("cargo clippy");
  }

  return { build, test, run, lint };
}

function detectFrameworks(cwd: string, languages: string[]): {
  framework: string[];
  backend: string[];
  frontend: string[];
  mobile: string[];
  vite: boolean;
} {
  const framework: string[] = [];
  const backend: string[] = [];
  const frontend: string[] = [];
  const mobile: string[] = [];
  let vite = false;

  if (languages.includes("Java") || languages.includes("Kotlin")) {
    const gradle = tryReadText(join(cwd, "build.gradle")) || tryReadText(join(cwd, "build.gradle.kts"));
    const pom = tryReadText(join(cwd, "pom.xml"));
    const springMarkers = ["org.springframework.boot", "spring-boot-starter"];
    if (springMarkers.some((m) => gradle?.includes(m) || pom?.includes(m))) {
      backend.push("Spring Boot");
      framework.push("Spring Boot");
    }
  }

  if (languages.includes("Dart")) {
    const pubspec = tryReadText(join(cwd, "pubspec.yaml")) || "";
    if (pubspec.includes("flutter:")) {
      mobile.push("Flutter");
      framework.push("Flutter");
    }
  }

  if (languages.includes("TypeScript") || languages.includes("JavaScript")) {
    const pkgJson = readJsonSafe(join(cwd, "package.json"));
    const deps: Record<string, string> = {
      ...((pkgJson?.dependencies as Record<string, string>) || {}),
      ...((pkgJson?.devDependencies as Record<string, string>) || {}),
    };
    const fwMap: Record<string, [string[], string[]]> = {
      NestJS: [["@nestjs/core"], backend],
      "Next.js": [["next"], frontend],
      Angular: [["@angular/core"], frontend],
      React: [["react"], frontend],
      Vue: [["vue"], frontend],
      Express: [["express"], backend],
      Fastify: [["fastify"], backend],
      SvelteKit: [["@sveltejs/kit"], frontend],
      Nuxt: [["nuxt"], frontend],
      Remix: [["@remix-run/react"], frontend],
      Astro: [["astro"], frontend],
    };
    for (const [name, [pkgs, bucket]] of Object.entries(fwMap)) {
      if (pkgs.some((p) => deps[p])) {
        framework.push(name);
        bucket.push(name);
      }
    }

    vite = !!deps["vite"];
  }

  return {
    framework: Array.from(new Set(framework)),
    backend: Array.from(new Set(backend)),
    frontend: Array.from(new Set(frontend)),
    mobile: Array.from(new Set(mobile)),
    vite,
  };
}

function detectFromPackageJson(cwd: string): {
  orm: string[];
  auth: string[];
  testing: string[];
  validation: string[];
  styling: string[];
  build: string[];
  stateManagement: string[];
  db: string[];
  monorepo: string[];
} {
  const pkgJson = readJsonSafe(join(cwd, "package.json"));
  const deps: Record<string, string> = {
    ...((pkgJson?.dependencies as Record<string, string>) || {}),
    ...((pkgJson?.devDependencies as Record<string, string>) || {}),
  };

  const detect = (patterns: Record<string, string>): string[] => {
    const found: string[] = [];
    for (const [pkg, label] of Object.entries(patterns)) {
      if (deps[pkg] || deps[`@types/${pkg}`]) found.push(label);
    }
    return found;
  };

  return {
    orm: detect({
      "@prisma/client": "Prisma", "prisma": "Prisma", "typeorm": "TypeORM",
      "drizzle-orm": "Drizzle", "mongoose": "Mongoose", "sequelize": "Sequelize",
      "knex": "Knex", "mikro-orm": "MikroORM",
    }),
    auth: detect({
      "@nestjs/jwt": "JWT (NestJS)", "@nestjs/passport": "Passport (NestJS)",
      "passport": "Passport", "jsonwebtoken": "JWT", "next-auth": "NextAuth",
      "@clerk/nextjs": "Clerk", "lucia-auth": "Lucia", "bcrypt": "Password hashing",
      "argon2": "Password hashing",
    }),
    testing: detect({
      "jest": "Jest", "vitest": "Vitest", "mocha": "Mocha", "cypress": "Cypress",
      "playwright": "Playwright", "@playwright/test": "Playwright", "puppeteer": "Puppeteer",
      "supertest": "Supertest", "@testing-library/react": "Testing Library",
    }),
    validation: detect({
      "zod": "Zod", "class-validator": "class-validator", "class-transformer": "class-transformer",
      "joi": "Joi", "yup": "Yup", "valibot": "Valibot",
    }),
    styling: detect({
      "tailwindcss": "Tailwind CSS", "styled-components": "styled-components",
      "@emotion/react": "Emotion", "sass": "Sass", "less": "Less",
      "@stitches/react": "Stitches", "daisyui": "DaisyUI", "shadcn-ui": "Shadcn/ui",
      "@radix-ui/react": "Radix UI", "@mantine/core": "Mantine",
      "@chakra-ui/react": "Chakra UI", "antd": "Ant Design",
    }),
    build: detect({
      "vite": "Vite", "webpack": "Webpack", "tsup": "tsup", "esbuild": "esbuild",
      "rollup": "Rollup", "parcel": "Parcel", "turbopack": "Turbopack",
    }),
    stateManagement: detect({
      "zustand": "Zustand", "redux": "Redux", "@reduxjs/toolkit": "Redux Toolkit",
      "jotai": "Jotai", "valtio": "Valtio", "mobx": "MobX", "pinia": "Pinia",
      "vuex": "Vuex", "recoil": "Recoil", "@tanstack/react-query": "TanStack Query",
    }),
    db: [],
    monorepo: detect({
      "turbo": "Turborepo", "nx": "Nx", "lerna": "Lerna", "rush": "Rush",
      "@changesets/cli": "Changesets",
    }),
  };
}

function extractTopDependencies(cwd: string, languages: string[]): Record<string, string[]> {
  const deps: Record<string, string[]> = {};

  const pkgJson = readJsonSafe(join(cwd, "package.json"));
  if (pkgJson) {
    const runtime = Object.keys((pkgJson.dependencies as Record<string, string>) || {});
    const dev = Object.keys((pkgJson.devDependencies as Record<string, string>) || {});
    deps.node = runtime.slice(0, 30);
    if (dev.length) deps.nodeDev = dev.slice(0, 20);
  }

  const pubspec = tryReadText(join(cwd, "pubspec.yaml"));
  if (pubspec) {
    try {
      const parsed = parseYaml(pubspec) as Record<string, Record<string, string>>;
      if (parsed.dependencies) deps.flutter = Object.keys(parsed.dependencies).slice(0, 30);
      if (parsed.dev_dependencies) deps.flutterDev = Object.keys(parsed.dev_dependencies).slice(0, 20);
    } catch { /* ignore */ }
  }

  const gradle = tryReadText(join(cwd, "build.gradle")) || tryReadText(join(cwd, "build.gradle.kts"));
  if (gradle && (languages.includes("Java") || languages.includes("Kotlin"))) {
    const starterRe = /(?:implementation|api)\s+['"](org\.springframework\.boot:spring-boot-starter-[\w-]+)['"]/g;
    const starters: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = starterRe.exec(gradle)) !== null) {
      const coord = m[1];
      if (!coord.startsWith("org.springframework.boot:")) continue;
      const name = coord.split("-").pop() ?? coord;
      starters.push(`Spring Boot Starter: ${name}`);
    }
    if (starters.length) deps.springBoot = Array.from(new Set(starters)).slice(0, 30);
  }

  const pom = tryReadText(join(cwd, "pom.xml"));
  if (pom && (languages.includes("Java") || languages.includes("Kotlin"))) {
    const starters: string[] = [];
    const dependencyBlockRe = /<dependency>([\s\S]*?)<\/dependency>/g;
    let depMatch: RegExpExecArray | null;
    while ((depMatch = dependencyBlockRe.exec(pom)) !== null) {
      const block = depMatch[1];
      const groupId = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1];
      const artifactId = block.match(/<artifactId>(spring-boot-starter-[\w-]+)<\/artifactId>/)?.[1];
      if (groupId === "org.springframework.boot" && artifactId) {
        const name = artifactId.split("-").pop() ?? artifactId;
        starters.push(`Spring Boot Starter: ${name}`);
      }
    }
    if (starters.length) {
      const existing = new Set(deps.springBoot || []);
      for (const s of starters) existing.add(s);
      deps.springBoot = Array.from(existing).slice(0, 30);
    }
  }

  const cargo = tryReadText(join(cwd, "Cargo.toml"));
  if (cargo && languages.includes("Rust")) {
    try {
      const parsed = parseYaml(cargo) as { dependencies?: Record<string, unknown> };
      if (parsed.dependencies) deps.rust = Object.keys(parsed.dependencies).slice(0, 30);
    } catch { /* ignore */ }
  }

  const requirements = tryReadText(join(cwd, "requirements.txt"));
  if (requirements && languages.includes("Python")) {
    deps.python = requirements
      .split("\n")
      .map((line) => line.trim().split(/[=<>!~]/)[0])
      .filter(Boolean)
      .slice(0, 30);
  }

  const pyproject = tryReadText(join(cwd, "pyproject.toml"));
  if (pyproject && languages.includes("Python")) {
    try {
      const parsed = parseYaml(pyproject) as { dependencies?: Record<string, string>, "dev-dependencies"?: Record<string, string> };
      if (parsed.dependencies) deps.python = Object.keys(parsed.dependencies).slice(0, 30);
    } catch { /* ignore */ }
  }

  return deps;
}

function buildBoundedTree(cwd: string, sourceRoots: string[], maxEntries = 40): string[] {
  const tree: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", ".pi", "dist", "build", ".next", ".turbo", "coverage", "target"]);
  let entriesLeft = maxEntries;

  function walk(dir: string, prefix: string, depth: number): void {
    if (entriesLeft <= 0 || depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.startsWith(".") && e !== ".env") continue;
      if (skipDirs.has(e)) continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) dirs.push(e);
        else files.push(e);
      } catch { /* ignore */ }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    for (const d of dirs) {
      if (entriesLeft <= 0) return;
      tree.push(`${prefix}${d}/`);
      entriesLeft--;
      walk(join(dir, d), `${prefix}  ${d}/`, depth + 1);
    }
    for (const f of files.slice(0, Math.max(0, entriesLeft))) {
      tree.push(`${prefix}${f}`);
      entriesLeft--;
    }
  }

  const roots = sourceRoots.length ? sourceRoots : ["."];
  for (const root of roots) {
    if (entriesLeft <= 0) break;
    if (existsSync(join(cwd, root))) {
      tree.push(`${root}/`);
      entriesLeft--;
      walk(join(cwd, root), `  ${root}/`, 1);
    }
  }

  return tree;
}

function detectKeyFiles(cwd: string, entryPoints: string[], configFiles: string[]): string[] {
  const key: string[] = [];
  const candidates = [
    ...entryPoints,
    ...configFiles,
    ".github/workflows/ci.yml",
    ".github/workflows/test.yml",
    ".github/workflows/build.yml",
    ".dockerignore",
    "docker-compose.override.yml",
    "vite.config.ts",
    "vite.config.js",
    "next.config.js",
    "next.config.ts",
    "vue.config.js",
    "angular.json",
    "tailwind.config.js",
    "tailwind.config.ts",
    "jest.config.js",
    "vitest.config.ts",
    "playwright.config.ts",
    "prisma/schema.prisma",
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
  ];
  for (const file of candidates) {
    if (existsSync(join(cwd, file))) key.push(file);
  }
  return Array.from(new Set(key)).slice(0, 30);
}

function detectRoutes(cwd: string, framework: string[]): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  if (framework.includes("Next.js")) {
    const nextRoutes: string[] = [];
    if (existsSync(join(cwd, "app"))) nextRoutes.push("app/");
    if (existsSync(join(cwd, "pages"))) nextRoutes.push("pages/");
    if (existsSync(join(cwd, "app", "api"))) nextRoutes.push("app/api/");
    if (existsSync(join(cwd, "pages", "api"))) nextRoutes.push("pages/api/");
    if (nextRoutes.length) routes.next = nextRoutes;
  }
  if (framework.includes("NestJS")) {
    routes.nestjs = ["src/**/*.controller.ts"];
  }
  if (framework.includes("Express") || framework.includes("Fastify")) {
    const expr: string[] = [];
    if (existsSync(join(cwd, "src", "routes"))) expr.push("src/routes/");
    if (existsSync(join(cwd, "routes"))) expr.push("routes/");
    if (expr.length) routes.express = expr;
  }
  if (framework.includes("Spring Boot")) {
    routes.spring = [
      "src/main/java/**/controller/",
      "src/main/java/**/api/",
      "src/main/java/**/rest/",
    ];
  }
  if (framework.includes("Flutter")) {
    routes.flutter = ["lib/"];
  }
  if (framework.includes("Angular")) {
    routes.angular = ["src/app/"];
  }
  if (framework.includes("Vue")) {
    const vueRoutes: string[] = [];
    if (existsSync(join(cwd, "src", "views"))) vueRoutes.push("src/views/");
    if (existsSync(join(cwd, "src", "pages"))) vueRoutes.push("src/pages/");
    if (existsSync(join(cwd, "src", "router"))) vueRoutes.push("src/router/");
    if (vueRoutes.length) routes.vue = vueRoutes;
  }
  if (framework.includes("React")) {
    const reactRoutes: string[] = [];
    if (existsSync(join(cwd, "src", "pages"))) reactRoutes.push("src/pages/");
    if (existsSync(join(cwd, "src", "routes"))) reactRoutes.push("src/routes/");
    if (existsSync(join(cwd, "app"))) reactRoutes.push("app/");
    if (reactRoutes.length) routes.react = reactRoutes;
  }
  return routes;
}

function detectWorkspaces(cwd: string): { packages: string[] } | undefined {
  const packages: string[] = [];
  const pnpmWorkspace = tryReadText(join(cwd, "pnpm-workspace.yaml"));
  if (pnpmWorkspace) {
    try {
      const parsed = parseYaml(pnpmWorkspace) as { packages?: string[] };
      if (parsed.packages) packages.push(...parsed.packages);
    } catch { /* ignore */ }
  }
  const pkgJson = readJsonSafe(join(cwd, "package.json"));
  if (pkgJson?.workspaces) {
    const ws = pkgJson.workspaces as string[] | { packages?: string[] };
    if (Array.isArray(ws)) packages.push(...ws);
    else if (Array.isArray(ws.packages)) packages.push(...ws.packages);
  }
  if (existsSync(join(cwd, "packages"))) {
    try {
      for (const entry of readdirSync(join(cwd, "packages"))) {
        const full = join(cwd, "packages", entry);
        if (statSync(full).isDirectory()) packages.push(`packages/${entry}`);
      }
    } catch { /* ignore */ }
  }
  return packages.length ? { packages: Array.from(new Set(packages)) } : undefined;
}

function detectDatabases(cwd: string, languages: string[]): string[] {
  const found: string[] = [];
  const dc = tryReadText(join(cwd, "docker-compose.yml")) || tryReadText(join(cwd, "docker-compose.yaml")) || "";
  if (dc.includes("postgres") || dc.includes("postgresql")) found.push("PostgreSQL");
  if (dc.includes("mysql") || dc.includes("mariadb")) found.push("MySQL");
  if (dc.includes("mongo")) found.push("MongoDB");
  if (dc.includes("redis")) found.push("Redis");
  if (dc.includes("sqlite")) found.push("SQLite");

  if (languages.includes("Java") || languages.includes("Kotlin")) {
    const gradle = tryReadText(join(cwd, "build.gradle")) || tryReadText(join(cwd, "build.gradle.kts")) || "";
    if (gradle.includes("postgresql") || gradle.includes("org.postgresql")) found.push("PostgreSQL");
    if (gradle.includes("mysql") || gradle.includes("com.mysql")) found.push("MySQL");
    if (gradle.includes("h2")) found.push("H2");
  }

  const prisma = tryReadText(join(cwd, "prisma", "schema.prisma"));
  if (prisma) {
    if (prisma.includes("postgresql")) found.push("PostgreSQL");
    if (prisma.includes("mysql")) found.push("MySQL");
    if (prisma.includes("sqlite")) found.push("SQLite");
    if (prisma.includes("mongodb")) found.push("MongoDB");
  }

  return Array.from(new Set(found));
}

function inferType(languages: string[], framework: string[]): string {
  if (framework.includes("Flutter")) return "flutter-mobile";
  if (framework.includes("Spring Boot")) return "spring-boot-backend";
  if (framework.includes("NestJS") || framework.includes("Express") || framework.includes("Fastify")) return "node-backend";
  if (framework.includes("Next.js") || framework.includes("React") || framework.includes("Vue") || framework.includes("Angular")) return "web-frontend";
  if (framework.includes("Next.js") && framework.includes("NestJS")) return "fullstack-web";
  if (languages.includes("Python")) return "python-backend";
  if (languages.includes("Go")) return "go-backend";
  if (languages.includes("Rust")) return "rust-cli";
  return "generic";
}

function inferConventions(_cwd: string, languages: string[], framework: string[]): ProjectMap["conventions"] {
  const conventions: ProjectMap["conventions"] = {};

  if (framework.includes("Flutter")) {
    conventions.folderStructure = "Feature-first or layer-first under lib/";
    conventions.naming = "snake_case files, PascalCase widgets/classes";
    conventions.stateManagement = "Check for Riverpod, Bloc, Provider, or GetX";
  }

  if (framework.includes("Spring Boot")) {
    conventions.folderStructure = "Package-by-feature under src/main/java/";
    conventions.naming = "PascalCase classes, camelCase methods/fields";
    conventions.layering = "Controller → Service → Repository";
  }

  if (framework.includes("NestJS")) {
    conventions.folderStructure = "Module-based under src/";
    conventions.layering = "Controller → Service → Repository/Provider";
  }

  if (languages.includes("TypeScript") || languages.includes("JavaScript")) {
    conventions.folderStructure = "Check src/, app/, or packages/";
    conventions.naming = "camelCase/ts files, PascalCase components";
  }

  if (languages.includes("Go")) {
    conventions.folderStructure = "Package-based, cmd/ and internal/ common";
    conventions.naming = "PascalCase exported, camelCase internal";
  }

  if (languages.includes("Python")) {
    conventions.folderStructure = "Check src/, app/, or flat module files";
    conventions.naming = "snake_case modules, PascalCase classes";
  }

  return conventions;
}

function inferArchitecture(framework: string[], _languages: string[]): ProjectMap["architecture"] {
  const patterns: string[] = [];
  const layers: Record<string, string[]> = {};

  if (framework.includes("Spring Boot")) {
    patterns.push("Layered architecture");
    layers.web = ["src/main/java/**/controller/", "src/main/java/**/api/"];
    layers.service = ["src/main/java/**/service/"];
    layers.repository = ["src/main/java/**/repository/", "src/main/java/**/dao/"];
    layers.model = ["src/main/java/**/entity/", "src/main/java/**/dto/"];
  }

  if (framework.includes("Flutter")) {
    patterns.push("Widget tree", "Feature modules");
    layers.presentation = ["lib/**/widgets/", "lib/**/screens/"];
    layers.domain = ["lib/**/models/", "lib/**/entities/"];
    layers.data = ["lib/**/repositories/", "lib/**/services/"];
  }

  if (framework.includes("NestJS")) {
    patterns.push("Modular DI architecture");
    layers.controllers = ["src/**/*.controller.ts"];
    layers.services = ["src/**/*.service.ts"];
    layers.modules = ["src/**/*.module.ts"];
  }

  return { patterns, layers };
}

export function generateProjectMap(cwd: string): ProjectMap {
  const languages = detectLanguages(cwd);
  const packageManager = detectPackageManagers(cwd);
  const { framework, backend, frontend, mobile, vite } = detectFrameworks(cwd, languages);
  const pkgData = detectFromPackageJson(cwd);
  const db = detectDatabases(cwd, languages);
  const entryPoints = detectEntryPoints(cwd, languages);
  const sourceRoots = detectSourceRoots(cwd, languages);
  const testRoots = detectTestRoots(cwd);
  const configFiles = detectConfigFiles(cwd);
  const rootDirs = detectRootDirs(cwd);
  const envFiles = detectEnvFiles(cwd);
  const commands = detectCommands(cwd, packageManager, languages);
  const conventions = inferConventions(cwd, languages, framework);
  const architecture = inferArchitecture(framework, languages);
  const dependencies = extractTopDependencies(cwd, languages);
  const tree = buildBoundedTree(cwd, sourceRoots, 40);
  const keyFiles = detectKeyFiles(cwd, entryPoints, configFiles);
  const routes = detectRoutes(cwd, framework);
  const workspaces = detectWorkspaces(cwd);

  if (vite && !pkgData.build.includes("Vite")) pkgData.build.push("Vite");

  const pkgJson = readJsonSafe(join(cwd, "package.json"));
  const pubspec = tryReadText(join(cwd, "pubspec.yaml"));
  const gradle = tryReadText(join(cwd, "build.gradle")) || tryReadText(join(cwd, "build.gradle.kts"));

  const projectName =
    (pkgJson?.name as string) ||
    (pubspec && parseYaml(pubspec)?.name) ||
    (tryReadText(join(cwd, "Cargo.toml")) && parseYaml(tryReadText(join(cwd, "Cargo.toml")) as string)?.package?.name) ||
    (tryReadText(join(cwd, "go.mod"))?.match(/^module\s+(\S+)/m)?.[1]) ||
    (gradle?.match(/rootProject\.name\s*=\s*["']([^"']+)["']/)?.[1]) ||
    (tryReadText(join(cwd, "pom.xml"))?.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]) ||
    "unknown";

  return {
    project: {
      name: projectName,
      type: inferType(languages, framework),
      language: languages[0] || "unknown",
      languages,
      entryPoints,
    },
    stack: {
      framework,
      backend,
      frontend,
      mobile,
      orm: pkgData.orm,
      auth: pkgData.auth,
      testing: pkgData.testing,
      validation: pkgData.validation,
      styling: pkgData.styling,
      build: pkgData.build,
      stateManagement: pkgData.stateManagement,
      packageManager,
      db,
      monorepo: pkgData.monorepo,
    },
    structure: {
      rootDirs,
      sourceRoots,
      testRoots,
      configFiles,
      importantFiles: entryPoints.slice(0, 5),
    },
    conventions,
    config: {
      envFiles,
      buildCommands: commands.build,
      testCommands: commands.test,
      runCommands: commands.run,
      lintCommands: commands.lint,
    },
    architecture,
    dependencies,
    files: {
      tree,
      keyFiles,
    },
    routes,
    workspaces,
    notes: [
      "This map is a starting point. Run `/cdev map refresh` after major structural changes.",
      "Scout will use this map when available to focus exploration.",
    ],
    generatedAt: new Date().toISOString(),
    generatedBy: "cdev template scanner",
  };
}

export function loadProjectMap(cwd: string): ProjectMap | null {
  const path = getMapPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseYaml(readFileSync(path, "utf-8")) as ProjectMap;
    if (parsed && typeof parsed.project === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveProjectMap(cwd: string, map: ProjectMap): void {
  const path = getMapPath(cwd);
  mkdirSync(join(cwd, ".pi", "cdev"), { recursive: true });
  writeFileSync(path, stringifyYaml(map, { indent: 2, lineWidth: 0 }), "utf-8");
}

export function formatMapReport(map: ProjectMap): string {
  const lines: string[] = [];
  lines.push("── cdev project map ──────────────────────────────");
  lines.push(`  Project:  ${map.project.name}`);
  lines.push(`  Type:     ${map.project.type}`);
  lines.push(`  Languages: ${map.project.languages.join(", ")}`);
  if (map.stack.framework.length) lines.push(`  Framework: ${map.stack.framework.join(" + ")}`);
  if (map.stack.backend.length) lines.push(`  Backend:   ${map.stack.backend.join(", ")}`);
  if (map.stack.frontend.length) lines.push(`  Frontend:  ${map.stack.frontend.join(", ")}`);
  if (map.stack.mobile.length) lines.push(`  Mobile:    ${map.stack.mobile.join(", ")}`);
  if (map.stack.orm.length) lines.push(`  ORM:       ${map.stack.orm.join(", ")}`);
  if (map.stack.db.length) lines.push(`  Database:  ${map.stack.db.join(", ")}`);
  if (map.stack.testing.length) lines.push(`  Testing:   ${map.stack.testing.join(", ")}`);
  lines.push(`  Source:    ${map.structure.sourceRoots.join(", ") || "unknown"}`);
  lines.push(`  Entry:     ${map.project.entryPoints.join(", ") || "unknown"}`);
  lines.push("");
  lines.push(`  Saved to:  ${MAP_PATH.join("/")}`);
  lines.push("  Tip: `/cdev map refresh` to regenerate via scout+forge.");
  lines.push("──────────────────────────────────────────────────");
  return lines.join("\n");
}

export function summarizeMapForPrompt(map: ProjectMap): string {
  const lines: string[] = [];
  lines.push("<project_map>");
  lines.push(`Project: ${map.project.name} (${map.project.type})`);
  lines.push(`Languages: ${map.project.languages.join(", ")}`);
  if (map.stack.framework.length) lines.push(`Frameworks: ${map.stack.framework.join(", ")}`);
  if (map.stack.backend.length) lines.push(`Backend: ${map.stack.backend.join(", ")}`);
  if (map.stack.frontend.length) lines.push(`Frontend: ${map.stack.frontend.join(", ")}`);
  if (map.stack.mobile.length) lines.push(`Mobile: ${map.stack.mobile.join(", ")}`);
  if (map.stack.orm.length) lines.push(`ORM: ${map.stack.orm.join(", ")}`);
  if (map.stack.db.length) lines.push(`Database: ${map.stack.db.join(", ")}`);
  if (map.stack.testing.length) lines.push(`Testing: ${map.stack.testing.join(", ")}`);
  if (map.stack.stateManagement.length) lines.push(`State: ${map.stack.stateManagement.join(", ")}`);
  if (map.structure.sourceRoots.length) lines.push(`Source roots: ${map.structure.sourceRoots.join(", ")}`);
  if (map.project.entryPoints.length) lines.push(`Entry points: ${map.project.entryPoints.join(", ")}`);
  if (map.config.buildCommands.length) lines.push(`Build: ${map.config.buildCommands.join(", ")}`);
  if (map.config.testCommands.length) lines.push(`Test: ${map.config.testCommands.join(", ")}`);
  if (Object.keys(map.conventions).length) {
    lines.push("Conventions:");
    for (const [key, value] of Object.entries(map.conventions)) {
      if (value) lines.push(`  - ${key}: ${value}`);
    }
  }
  if (map.architecture.patterns.length) {
    lines.push(`Architecture patterns: ${map.architecture.patterns.join(", ")}`);
  }
  if (Object.keys(map.architecture.layers ?? {}).length) {
    lines.push("Layers:");
    for (const [layer, globs] of Object.entries(map.architecture.layers ?? {})) {
      lines.push(`  - ${layer}: ${globs.join(", ")}`);
    }
  }
  if (Object.keys(map.dependencies).length) {
    lines.push("Key dependencies:");
    for (const [source, items] of Object.entries(map.dependencies)) {
      if (items.length) lines.push(`  - ${source}: ${items.slice(0, 10).join(", ")}`);
    }
  }
  if (map.files.keyFiles.length) {
    lines.push(`Key files: ${map.files.keyFiles.slice(0, 15).join(", ")}`);
  }
  if (map.routes && Object.keys(map.routes).length) {
    lines.push("Routes/API locations:");
    for (const [fw, paths] of Object.entries(map.routes)) {
      if (paths.length) lines.push(`  - ${fw}: ${paths.join(", ")}`);
    }
  }
  if (map.workspaces?.packages.length) {
    lines.push(`Workspaces: ${map.workspaces.packages.join(", ")}`);
  }
  if (map.files.tree.length) {
    lines.push("Directory skeleton:");
    for (const line of map.files.tree.slice(0, 30)) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("</project_map>");
  return lines.join("\n");
}
