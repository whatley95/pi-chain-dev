/**
 * Kimi usage provider.
 *
 * Fetches Kimi API usage and formats a compact footer line similar to
 * pi-kimi-usage. Activated when the main model is a kimi-coding variant and
 * the user has enabled the feature in config.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface KimiUsagePeriod {
  period: string;
  total: number;
  used: number;
  percentage: number;
}

export interface KimiUsageResponse {
  data?: {
    periods?: KimiUsagePeriod[];
  };
}

export interface KimiUsageSummary {
  line: string;
  totalPercentage: number;
}

const KIMI_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1/usages";

export function isKimiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId.toLowerCase().startsWith("kimi");
}

export function resolveKimiBaseUrl(): string {
  return process.env["KIMI_CODE_BASE_URL"] || KIMI_DEFAULT_BASE_URL;
}

export function resolveKimiApiKey(_cwd?: string): string | undefined {
  const envKey = process.env["KIMI_API_KEY"];
  if (envKey) return envKey;

  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) return undefined;

  try {
    const raw = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const kimiAuth = auth["kimi-coding"];
    if (!kimiAuth || typeof kimiAuth !== "object") return undefined;
    const keyValue = (kimiAuth as Record<string, unknown>)["key"];
    if (typeof keyValue !== "string") return undefined;

    if (keyValue.startsWith("!")) {
      const command = keyValue.slice(1).trim();
      if (!command) return undefined;
      try {
        return execSync(command, { encoding: "utf-8", timeout: 5000 }).trim();
      } catch {
        return undefined;
      }
    }

    if (/^[A-Z_][A-Z0-9_]*$/i.test(keyValue)) {
      const resolved = process.env[keyValue];
      if (resolved) return resolved;
    }

    return keyValue;
  } catch {
    return undefined;
  }
}

function formatDuration(minutes: number): string {
  if (minutes >= 60 * 24) {
    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);
    return `${days}d${hours}h`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    return `${hours}h${mins.toString().padStart(2, "0")}m`;
  }
  return `${Math.floor(minutes)}m`;
}

export function formatKimiUsage(periods: KimiUsagePeriod[]): KimiUsageSummary | null {
  if (!periods || periods.length === 0) return null;

  const sorted = [...periods].sort((a, b) => {
    const order: Record<string, number> = { "7d": 0, "1d": 1, "24h": 1, "30d": 2, "31d": 2 };
    return (order[a.period] ?? 99) - (order[b.period] ?? 99);
  });

  const parts: string[] = [];
  let totalPercentage = 0;
  for (const p of sorted.slice(0, 2)) {
    const remaining = Math.max(0, p.total - p.used);
    const remainingMin = remaining;
    parts.push(`${p.period} ${p.percentage}% ${formatDuration(remainingMin)}`);
    totalPercentage = Math.max(totalPercentage, p.percentage);
  }

  if (parts.length === 0) return null;
  return { line: `Kimi · ${parts.join(" · ")}`, totalPercentage };
}

export async function fetchKimiUsage(apiKey?: string, baseUrl?: string): Promise<KimiUsageSummary | null> {
  const key = apiKey ?? resolveKimiApiKey();
  if (!key) return null;

  const url = baseUrl ?? resolveKimiBaseUrl();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as KimiUsageResponse;
    const periods = body.data?.periods;
    if (!periods || periods.length === 0) return null;

    return formatKimiUsage(periods);
  } catch {
    return null;
  }
}

export async function getKimiUsageLine(modelId?: string): Promise<string | undefined> {
  if (!isKimiModel(modelId)) return undefined;
  const usage = await fetchKimiUsage();
  return usage?.line;
}
