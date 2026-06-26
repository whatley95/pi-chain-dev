import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isKimiModel,
  formatKimiBalance,
  fetchKimiUsage,
  diagnoseKimiUsage,
  type KimiBalanceResponse,
} from "../src/kimi-usage.js";

describe("kimi-usage", () => {
  describe("isKimiModel", () => {
    it("returns true for kimi model ids", () => {
      assert.strictEqual(isKimiModel("kimi-for-coding"), true);
      assert.strictEqual(isKimiModel("kimi-k2.7-code"), true);
    });

    it("returns false for non-kimi ids", () => {
      assert.strictEqual(isKimiModel("gpt-4"), false);
      assert.strictEqual(isKimiModel(undefined), false);
    });
  });

  describe("formatKimiBalance", () => {
    it("formats positive balance", () => {
      assert.strictEqual(formatKimiBalance(49.58894), "¥49.59");
    });

    it("formats zero balance", () => {
      assert.strictEqual(formatKimiBalance(0), "¥0.00");
    });

    it("returns null for non-finite values", () => {
      assert.strictEqual(formatKimiBalance(NaN), null);
      assert.strictEqual(formatKimiBalance(Infinity), null);
    });
  });

  describe("fetchKimiUsage", () => {
    it("returns null when api key is missing", async () => {
      const original = process.env["KIMI_API_KEY"];
      const originalMoonshot = process.env["MOONSHOT_API_KEY"];
      delete process.env["KIMI_API_KEY"];
      delete process.env["MOONSHOT_API_KEY"];
      try {
        const result = await fetchKimiUsage(undefined, "http://localhost:0");
        assert.strictEqual(result, null);
      } finally {
        if (original === undefined) delete process.env["KIMI_API_KEY"]; else process.env["KIMI_API_KEY"] = original;
        if (originalMoonshot === undefined) delete process.env["MOONSHOT_API_KEY"]; else process.env["MOONSHOT_API_KEY"] = originalMoonshot;
      }
    });

    it("formats balance from mocked response", async () => {
      const response: KimiBalanceResponse = {
        code: 0,
        status: true,
        data: { available_balance: 12.3456, voucher_balance: 10, cash_balance: 2.3456 },
      };
      const server = async (_req: Request) => {
        return new Response(JSON.stringify(response), { status: 200 });
      };
      // Minimal mock server via global fetch override
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => server(new Request("http://localhost:0"));
      try {
        const result = await fetchKimiUsage("test-key", "http://localhost:0");
        assert.ok(result);
        assert.strictEqual(result?.line, "Kimi · ¥12.35");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns null when response has no balance", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      try {
        const result = await fetchKimiUsage("test-key", "http://localhost:0");
        assert.strictEqual(result, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns null on non-ok response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
      try {
        const result = await fetchKimiUsage("test-key", "http://localhost:0");
        assert.strictEqual(result, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("diagnoseKimiUsage", () => {
    it("rejects non-kimi model", async () => {
      const result = await diagnoseKimiUsage("gpt-4");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes("not a kimi model"));
    });

    it("diagnoses missing key", async () => {
      const original = process.env["KIMI_API_KEY"];
      const originalMoonshot = process.env["MOONSHOT_API_KEY"];
      const originalUserProfile = process.env["USERPROFILE"];
      const originalHome = process.env["HOME"];
      delete process.env["KIMI_API_KEY"];
      delete process.env["MOONSHOT_API_KEY"];
      process.env["USERPROFILE"] = "C:\\__nonexistent_home_for_test__";
      process.env["HOME"] = "/__nonexistent_home_for_test__";
      try {
        const result = await diagnoseKimiUsage("kimi-for-coding");
        assert.strictEqual(result.ok, false);
        assert.ok(result.error?.includes("no KIMI_API_KEY"));
      } finally {
        if (original === undefined) delete process.env["KIMI_API_KEY"]; else process.env["KIMI_API_KEY"] = original;
        if (originalMoonshot === undefined) delete process.env["MOONSHOT_API_KEY"]; else process.env["MOONSHOT_API_KEY"] = originalMoonshot;
        if (originalUserProfile === undefined) delete process.env["USERPROFILE"]; else process.env["USERPROFILE"] = originalUserProfile;
        if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
      }
    });

    it("diagnoses API error code", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ code: 1001, status: false, error: { message: "bad request" } }),
          { status: 200 }
        );
      try {
        const result = await diagnoseKimiUsage("kimi-for-coding");
        assert.strictEqual(result.ok, false);
        assert.ok(result.error?.includes("Kimi API error"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns line for valid balance", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            code: 0,
            status: true,
            data: { available_balance: 7.5, voucher_balance: 5, cash_balance: 2.5 },
          }),
          { status: 200 }
        );
      try {
        const result = await diagnoseKimiUsage("kimi-for-coding");
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.line, "Kimi · ¥7.50");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
