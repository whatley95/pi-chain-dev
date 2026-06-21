/**
 * /cdev scan — project detector and prompt generator.
 *
 * Reads project files (package.json, configs, directory tree) to
 * detect the stack, then generates tight stage-specific prompts
 * focused on the right patterns, risks, and conventions.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptsConfig } from "./types.js";

// ── Detectors ────────────────────────────────────────────

interface DetectedStack {
  framework: string[];
  orm: string[];
  auth: string[];
  testing: string[];
  validation: string[];
  styling: string[];
  build: string[];
  stateManagement: string[];
  db: string[];
  packageManager: string;
  monorepo: string[];
  language: string;
}

function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function detectFromDeps(deps: Record<string, string> | undefined, patterns: Record<string, string>): string[] {
  const found: string[] = [];
  if (!deps) return found;
  for (const [pkg, label] of Object.entries(patterns)) {
    if (deps[pkg] || deps[`@types/${pkg}`]) {
      found.push(label);
    }
  }
  return found;
}

function detectStack(cwd: string): DetectedStack {
  const pkgJson = readJsonSafe(join(cwd, "package.json"));
  const allDeps: Record<string, string> = {
    ...((pkgJson?.dependencies as Record<string, string>) || {}),
    ...((pkgJson?.devDependencies as Record<string, string>) || {}),
  };

  const result: DetectedStack = {
    framework: [],
    orm: [],
    auth: [],
    testing: [],
    validation: [],
    styling: [],
    build: [],
    stateManagement: [],
    db: [],
    packageManager: detectPackageManager(cwd),
    monorepo: [],
    language: existsSync(join(cwd, "tsconfig.json")) ? "TypeScript" : "JavaScript",
  };

  // Framework detection
  result.framework = detectFromDeps(allDeps, {
    "@nestjs/core": "NestJS",
    "@nestjs/common": "NestJS",
    "next": "Next.js",
    "@angular/core": "Angular",
    "vue": "Vue",
    "react": "React",
    "express": "Express",
    "fastify": "Fastify",
    "koa": "Koa",
    "hono": "Hono",
    "@sveltejs/kit": "SvelteKit",
    "nuxt": "Nuxt",
    "remix": "Remix",
    "astro": "Astro",
  });

  // ORM
  result.orm = detectFromDeps(allDeps, {
    "@prisma/client": "Prisma",
    "prisma": "Prisma",
    "typeorm": "TypeORM",
    "drizzle-orm": "Drizzle",
    "mongoose": "Mongoose",
    "sequelize": "Sequelize",
    "knex": "Knex",
    "mikro-orm": "MikroORM",
  });

  // Auth
  result.auth = detectFromDeps(allDeps, {
    "@nestjs/jwt": "JWT (NestJS)",
    "@nestjs/passport": "Passport (NestJS)",
    "passport": "Passport",
    "jsonwebtoken": "JWT",
    "next-auth": "NextAuth",
    "@clerk/nextjs": "Clerk",
    "lucia-auth": "Lucia",
    "bcrypt": "Password hashing",
    "argon2": "Password hashing",
  });

  // Testing
  result.testing = detectFromDeps(allDeps, {
    "jest": "Jest",
    "vitest": "Vitest",
    "mocha": "Mocha",
    "cypress": "Cypress",
    "playwright": "Playwright",
    "@playwright/test": "Playwright",
    "puppeteer": "Puppeteer",
    "supertest": "Supertest",
    "@testing-library/react": "Testing Library",
  });

  // Validation
  result.validation = detectFromDeps(allDeps, {
    "zod": "Zod",
    "class-validator": "class-validator",
    "class-transformer": "class-transformer",
    "joi": "Joi",
    "yup": "Yup",
    "valibot": "Valibot",
  });

  // Styling
  result.styling = detectFromDeps(allDeps, {
    "tailwindcss": "Tailwind CSS",
    "styled-components": "styled-components",
    "@emotion/react": "Emotion",
    "sass": "Sass",
    "less": "Less",
    "@stitches/react": "Stitches",
    "daisyui": "DaisyUI",
    "shadcn-ui": "Shadcn/ui",
    "@radix-ui/react": "Radix UI",
    "@mantine/core": "Mantine",
    "@chakra-ui/react": "Chakra UI",
    "antd": "Ant Design",
  });

  // Build
  result.build = detectFromDeps(allDeps, {
    "vite": "Vite",
    "webpack": "Webpack",
    "tsup": "tsup",
    "esbuild": "esbuild",
    "rollup": "Rollup",
    "parcel": "Parcel",
    "turbopack": "Turbopack",
  });

  // State management
  result.stateManagement = detectFromDeps(allDeps, {
    "zustand": "Zustand",
    "redux": "Redux",
    "@reduxjs/toolkit": "Redux Toolkit",
    "jotai": "Jotai",
    "valtio": "Valtio",
    "mobx": "MobX",
    "pinia": "Pinia",
    "vuex": "Vuex",
    "recoil": "Recoil",
    "@tanstack/react-query": "TanStack Query",
  });

  // Database (from Docker/compose files + ORM configs)
  if (existsSync(join(cwd, "docker-compose.yml")) || existsSync(join(cwd, "docker-compose.yaml"))) {
    try {
      const dc = readFileSync(
        existsSync(join(cwd, "docker-compose.yml"))
          ? join(cwd, "docker-compose.yml")
          : join(cwd, "docker-compose.yaml"),
        "utf-8"
      );
      if (dc.includes("postgres") || dc.includes("postgresql")) result.db.push("PostgreSQL");
      if (dc.includes("mysql") || dc.includes("mariadb")) result.db.push("MySQL");
      if (dc.includes("mongo")) result.db.push("MongoDB");
      if (dc.includes("redis")) result.db.push("Redis");
      if (dc.includes("sqlite")) result.db.push("SQLite");
    } catch { /* ignore */ }
  }
  if (existsSync(join(cwd, "prisma", "schema.prisma"))) {
    try {
      const schema = readFileSync(join(cwd, "prisma", "schema.prisma"), "utf-8");
      if (schema.includes("postgresql")) result.db.push("PostgreSQL");
      if (schema.includes("mysql")) result.db.push("MySQL");
      if (schema.includes("sqlite")) result.db.push("SQLite");
      if (schema.includes("mongodb")) result.db.push("MongoDB");
    } catch { /* ignore */ }
  }

  // Monorepo
  result.monorepo = detectFromDeps(allDeps, {
    "turbo": "Turborepo",
    "@nx/nx-linux-x64-gnu": "Nx",
    "nx": "Nx",
    "lerna": "Lerna",
    "rush": "Rush",
    "@changesets/cli": "Changesets",
  });

  return result;
}

// ── Prompt generator ─────────────────────────────────────

function generateExplorePrompt(stack: DetectedStack): string {
  const lines: string[] = [];
  
  const lang = stack.language;
  const frameworks = stack.framework.length > 0 ? stack.framework.join(" + ") : "vanilla";
  lines.push(`You are exploring a ${lang} project using ${frameworks}.`);

  // Framework-specific guidance
  if (stack.framework.includes("NestJS")) {
    lines.push("Focus: module dependency graph, guard/pipe/interceptor chains, controller → service → repository flow, @Injectable scopes.");
  } else if (stack.framework.includes("Next.js")) {
    lines.push("Focus: page routes, API routes, server components, middleware chain, data fetching patterns (SSR/SSG/ISR).");
  } else if (stack.framework.includes("React")) {
    lines.push("Focus: component tree, hook dependencies, context providers, render patterns, side effects.");
  } else if (stack.framework.includes("Fastify") || stack.framework.includes("Express")) {
    lines.push("Focus: route registration, middleware stack, error handlers, plugin/extension loading order.");
  }

  if (stack.orm.length > 0) {
    const orms = stack.orm.join(", ");
    lines.push(`ORM: ${orms}. Trace entity definitions, migration files, query patterns, relation mappings.`);
  }

  if (stack.auth.length > 0) {
    lines.push(`Auth: ${stack.auth.join(", ")}. Map auth guards, token handling, permission checks, session lifecycle.`);
  }

  if (stack.validation.length > 0) {
    lines.push(`Validation: ${stack.validation.join(", ")}. Note DTO/schema locations and validation pipe configurations.`);
  }

  lines.push("");
  lines.push("Instructions:");
  lines.push("- Use read, bash, grep to gather concrete evidence");
  lines.push("- Return raw findings: file paths, dependency chains, config values, export maps");
  lines.push("- Do NOT synthesize or write a report — just gather");
  lines.push("- Skip: node_modules, dist, .git, lock files, test files (unless asked)");

  return lines.join("\n");
}

function generateSynthesizePrompt(stack: DetectedStack): string {
  const lines: string[] = [];
  lines.push("Synthesize the exploration findings into a decision-useful report.");
  lines.push("");
  lines.push("Include:");
  lines.push("- All files touched, in dependency order (upstream → downstream)");

  if (stack.framework.includes("NestJS")) {
    lines.push("- Module dependency graph changes — which modules are affected?");
    lines.push("- Guard/pipe/interceptor ordering implications");
  }
  if (stack.orm.length > 0) {
    lines.push("- Schema/migration impact — new migrations? Breaking schema changes?");
    lines.push("- Query pattern changes and potential N+1 risks");
  }
  if (stack.auth.length > 0) {
    lines.push("- Auth impact: new permissions needed? Guard changes? Token flow altered?");
  }

  lines.push("- Breakage risk per file (low/medium/high)");
  lines.push("- Suggested implementation order with reasons");
  lines.push("");
  lines.push("Use sections: ## Result, ## Output, ## Evidence, ## Learnings");

  return lines.join("\n");
}

function generateReviewPrompt(stack: DetectedStack): string {
  const lines: string[] = [];
  lines.push("Review the code changes in this session critically.");
  lines.push("");

  const checks: string[] = [];

  if (stack.framework.includes("NestJS")) {
    checks.push("Missing @UseGuards / @UseInterceptors decorators");
    checks.push("Circular module dependencies");
    checks.push("Unhandled async errors in service methods");
    checks.push("Improper @Injectable scope usage");
  }
  if (stack.orm.includes("Prisma")) {
    checks.push("N+1 queries — check for missing includes or improper loop queries");
    checks.push("Raw SQL without parameterization (SQL injection risk)");
    checks.push("Transaction boundaries — are related writes atomic?");
  }
  if (stack.auth.length > 0) {
    checks.push("Unprotected routes missing auth guards");
    checks.push("Hardcoded secrets or API keys");
    checks.push("Token expiration/refresh logic correctness");
  }
  if (stack.validation.includes("class-validator")) {
    checks.push("DTOs missing validation decorators on user-input fields");
  }
  if (stack.validation.includes("Zod")) {
    checks.push("Zod schemas missing on API boundaries");
  }

  checks.push("Error handling gaps — try/catch coverage on async operations");
  checks.push("TypeScript type safety — any usage, missing null checks");
  checks.push("Dead code, unused imports, duplicate logic");
  checks.push("Style inconsistencies with existing patterns");

  lines.push("Check for:");
  for (const c of checks) lines.push(`- ${c}`);

  lines.push("");
  lines.push("Use sections: ## Result (pass/needs-work/blocked), ## Issues Found, ## Suggestions, ## Evidence");

  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────

export interface ScanResult {
  stack: DetectedStack;
  prompts: PromptsConfig;
}

export function scanProject(cwd: string): ScanResult {
  const stack = detectStack(cwd);
  return {
    stack,
    prompts: {
      explore: generateExplorePrompt(stack),
      synthesize: generateSynthesizePrompt(stack),
      review: generateReviewPrompt(stack),
    },
  };
}

export function formatScanReport(result: ScanResult): string {
  const { stack, prompts } = result;
  const lines: string[] = [];

  lines.push("── Scanning project ──────────────────────────────");

  if (stack.framework.length > 0) lines.push(`  Framework:     ${stack.framework.join(" + ")} (${stack.language})`);
  else lines.push(`  Language:      ${stack.language}`);

  if (stack.orm.length > 0) lines.push(`  ORM:           ${stack.orm.join(", ")}`);
  if (stack.auth.length > 0) lines.push(`  Auth:          ${stack.auth.join(", ")}`);
  if (stack.testing.length > 0) lines.push(`  Testing:       ${stack.testing.join(", ")}`);
  if (stack.validation.length > 0) lines.push(`  Validation:    ${stack.validation.join(", ")}`);
  if (stack.styling.length > 0) lines.push(`  Styling:       ${stack.styling.join(", ")}`);
  if (stack.build.length > 0) lines.push(`  Build:         ${stack.build.join(", ")}`);
  if (stack.stateManagement.length > 0) lines.push(`  State:         ${stack.stateManagement.join(", ")}`);
  if (stack.db.length > 0) lines.push(`  Database:      ${stack.db.join(", ")}`);
  if (stack.monorepo.length > 0) lines.push(`  Monorepo:      ${stack.monorepo.join(", ")}`);
  lines.push(`  Package mgr:   ${stack.packageManager}`);
  lines.push("──────────────────────────────────────────────────");

  lines.push("");
  lines.push("Generated prompts:");
  lines.push("");
  lines.push(`Explore:    ${prompts.explore?.substring(0, 70)}...`);
  lines.push(`Synthesize: ${prompts.synthesize?.substring(0, 70)}...`);
  lines.push(`Review:     ${prompts.review?.substring(0, 70)}...`);
  lines.push("");
  lines.push("✓ Saved to .pi/settings.json");
  lines.push("  Toggle:  /cdev prompts on  |  /cdev prompts off");

  return lines.join("\n");
}
