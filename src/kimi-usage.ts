/**
 * Kimi usage provider.
 *
 * Fetches Kimi account balance from the documented public API and formats a
 * compact footer line. Activated when the main model is a kimi-coding variant
 * and the user has enabled the feature in config.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface KimiBalanceResponse {
  code?: number;
  status?: boolean;
  data?: {
    available_balance?: number;
    voucher_balance?: number;
    cash_balance?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export interface KimiUsageSummary {
  line: string;
}

const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1/users/me/balance";

export function isKimiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId.toLowerCase().startsWith("kimi");
}

export function resolveKimiBaseUrl(): string {
  return process.env["KIMI_BALANCE_URL"] || KIMI_DEFAULT_BASE_URL;
}

export function resolveKimiApiKey(_cwd?: string): string | undefined {
  const envKey = process.env["KIMI_API_KEY"] || process.env["MOONSHOT_API_KEY"];
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

export function formatKimiBalance(balance: number): string | null {
  if (!Number.isFinite(balance)) return null;
  return `¥${balance.toFixed(2)}`;
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

    const body = (await response.json()) as KimiBalanceResponse;
    const available = body.data?.available_balance;
    if (available === undefined || available === null) return null;

    const formatted = formatKimiBalance(available);
    if (!formatted) return null;

    return { line: `Kimi · ${formatted}` };
  } catch {
    return null;
  }
}

export interface KimiUsageDiagnostic {
  ok: boolean;
  line?: string;
  error?: string;
}

export async function diagnoseKimiUsage(modelId?: string): Promise<KimiUsageDiagnostic> {
  if (!isKimiModel(modelId)) {
    return { ok: false, error: `model ${modelId ?? "unknown"} is not a kimi model` };
  }
  const key = resolveKimiApiKey();
  if (!key) {
    return { ok: false, error: "no KIMI_API_KEY, MOONSHOT_API_KEY, or ~/.pi/agent/auth.json kimi-coding.key found" };
  }
  const url = resolveKimiBaseUrl();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `HTTP ${response.status} from ${url}: ${body.slice(0, 200)}` };
    }
    const data = (await response.json()) as KimiBalanceResponse;
    if (data.code !== undefined && data.code !== 0) {
      return { ok: false, error: `Kimi API error: ${data.error?.message ?? JSON.stringify(data)}` };
    }
    const available = data.data?.available_balance;
    if (available === undefined || available === null) {
      return { ok: false, error: "balance endpoint returned no available_balance" };
    }
    const usage = formatKimiBalance(available);
    if (!usage) {
      return { ok: false, error: "could not format balance" };
    }
    return { ok: true, line: `Kimi · ${usage}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
