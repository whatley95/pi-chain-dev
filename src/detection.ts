/**
 * /cdev detection — shared package-to-label detection patterns and helpers.
 *
 * Centralizes the detection logic used by both scan.ts and project-map.ts
 * to eliminate duplicated package-to-label mapping pairs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Package-to-label mapping patterns ───────────────────

interface DetectionMappings {
  orm: Record<string, string>;
  auth: Record<string, string>;
  testing: Record<string, string>;
  validation: Record<string, string>;
  styling: Record<string, string>;
  build: Record<string, string>;
  stateManagement: Record<string, string>;
  monorepo: Record<string, string>;
}

export const DETECTION_PATTERNS: DetectionMappings = {
  orm: {
    "@prisma/client": "Prisma",
    prisma: "Prisma",
    typeorm: "TypeORM",
    "drizzle-orm": "Drizzle",
    mongoose: "Mongoose",
    sequelize: "Sequelize",
    knex: "Knex",
    "mikro-orm": "MikroORM",
  },
  auth: {
    "@nestjs/jwt": "JWT (NestJS)",
    "@nestjs/passport": "Passport (NestJS)",
    passport: "Passport",
    jsonwebtoken: "JWT",
    "next-auth": "NextAuth",
    "@clerk/nextjs": "Clerk",
    "lucia-auth": "Lucia",
    bcrypt: "Password hashing",
    argon2: "Password hashing",
  },
  testing: {
    jest: "Jest",
    vitest: "Vitest",
    mocha: "Mocha",
    cypress: "Cypress",
    playwright: "Playwright",
    "@playwright/test": "Playwright",
    puppeteer: "Puppeteer",
    supertest: "Supertest",
    "@testing-library/react": "Testing Library",
  },
  validation: {
    zod: "Zod",
    "class-validator": "class-validator",
    "class-transformer": "class-transformer",
    joi: "Joi",
    yup: "Yup",
    valibot: "Valibot",
  },
  styling: {
    tailwindcss: "Tailwind CSS",
    "styled-components": "styled-components",
    "@emotion/react": "Emotion",
    sass: "Sass",
    less: "Less",
    "@stitches/react": "Stitches",
    daisyui: "DaisyUI",
    "shadcn-ui": "Shadcn/ui",
    "@radix-ui/react": "Radix UI",
    "@mantine/core": "Mantine",
    "@chakra-ui/react": "Chakra UI",
    antd: "Ant Design",
  },
  build: {
    vite: "Vite",
    webpack: "Webpack",
    tsup: "tsup",
    esbuild: "esbuild",
    rollup: "Rollup",
    parcel: "Parcel",
    turbopack: "Turbopack",
  },
  stateManagement: {
    zustand: "Zustand",
    redux: "Redux",
    "@reduxjs/toolkit": "Redux Toolkit",
    jotai: "Jotai",
    valtio: "Valtio",
    mobx: "MobX",
    pinia: "Pinia",
    vuex: "Vuex",
    recoil: "Recoil",
    "@tanstack/react-query": "TanStack Query",
  },
  monorepo: {
    turbo: "Turborepo",
    "@nx/nx-linux-x64-gnu": "Nx",
    nx: "Nx",
    lerna: "Lerna",
    rush: "Rush",
    "@changesets/cli": "Changesets",
  },
} as const;

// ── Framework detection patterns (JS/TS) ────────────────

export const FRAMEWORK_PATTERNS: Record<string, string> = {
  "@nestjs/core": "NestJS",
  "@nestjs/common": "NestJS",
  next: "Next.js",
  "@angular/core": "Angular",
  vue: "Vue",
  react: "React",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  hono: "Hono",
  "@sveltejs/kit": "SvelteKit",
  nuxt: "Nuxt",
  remix: "Remix",
  astro: "Astro",
};

// ── Helpers ─────────────────────────────────────────────

export function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectFromDeps(
  deps: Record<string, string> | undefined,
  patterns: Record<string, string>,
): string[] {
  const found: string[] = [];
  if (!deps) return found;
  for (const [pkg, label] of Object.entries(patterns)) {
    if (deps[pkg] || deps[`@types/${pkg}`]) {
      found.push(label);
    }
  }
  return found;
}

// ── Database detection from docker-compose and Prisma schema ──

export function detectDatabasesFromDockerCompose(cwd: string): string[] {
  const db: string[] = [];
  const composePath = existsSync(join(cwd, "docker-compose.yml"))
    ? join(cwd, "docker-compose.yml")
    : existsSync(join(cwd, "docker-compose.yaml"))
      ? join(cwd, "docker-compose.yaml")
      : null;
  if (!composePath) return db;

  try {
    const content = readFileSync(composePath, "utf-8");
    if (content.includes("postgres") || content.includes("postgresql")) db.push("PostgreSQL");
    if (content.includes("mysql") || content.includes("mariadb")) db.push("MySQL");
    if (content.includes("mongo")) db.push("MongoDB");
    if (content.includes("redis")) db.push("Redis");
    if (content.includes("sqlite")) db.push("SQLite");
  } catch {
    /* ignore */
  }
  return db;
}

export function detectDatabasesFromPrismaSchema(cwd: string): string[] {
  const db: string[] = [];
  const schemaPath = join(cwd, "prisma", "schema.prisma");
  if (!existsSync(schemaPath)) return db;

  try {
    const schema = readFileSync(schemaPath, "utf-8");
    if (schema.includes("postgresql")) db.push("PostgreSQL");
    if (schema.includes("mysql")) db.push("MySQL");
    if (schema.includes("sqlite")) db.push("SQLite");
    if (schema.includes("mongodb")) db.push("MongoDB");
  } catch {
    /* ignore */
  }
  return db;
}
