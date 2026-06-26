import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldBlockRead, shouldBlockGrep, shouldBlockGlob, shouldBlockBash, shouldBlockDiff, shouldBlockRepeatedRead, shouldBlockIntrospection, getPreferCdevReadRule, registerReadEnforcement } from "../src/read-enforcement.js";

describe("read-enforcement", () => {
  describe("shouldBlockRead", () => {
    it("blocks source files", () => {
      assert.ok(shouldBlockRead("src/index.ts"));
      assert.ok(shouldBlockRead("lib/foo.py"));
      assert.ok(shouldBlockRead("config.yaml"));
    });

    it("blocks extension-less project files", () => {
      assert.ok(shouldBlockRead("Makefile"));
      assert.ok(shouldBlockRead("Dockerfile"));
    });

    it("does not block README-style docs", () => {
      assert.equal(shouldBlockRead("README.md"), undefined);
      assert.equal(shouldBlockRead("AGENTS.md"), undefined);
      assert.equal(shouldBlockRead("LICENSE"), undefined);
    });

    it("does not block image/binary files", () => {
      assert.equal(shouldBlockRead("screenshot.png"), undefined);
      assert.equal(shouldBlockRead("archive.zip"), undefined);
      assert.equal(shouldBlockRead("document.pdf"), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockRead("src/foo.ts");
      assert.ok(result);
      assert.ok(result!.reason.includes("/cdev read src/foo.ts"));
      assert.ok(result!.reason.includes('cdev({ quick:true, task: "read src/foo.ts" })'));
    });
  });

  describe("getPreferCdevReadRule", () => {
    it("returns a non-empty rule with the injection marker", () => {
      const rule = getPreferCdevReadRule();
      assert.ok(rule.length > 0);
      assert.ok(rule.includes("pi-chain-dev:enforce-cdev-tools"));
      assert.ok(rule.includes("/cdev read"));
    });

    it("mentions up to three escalation reads", () => {
      const rule = getPreferCdevReadRule();
      assert.ok(rule.includes("ESCALATION"));
      assert.ok(rule.includes("up to THREE"));
    });

    it("mentions cooldown escape valve", () => {
      const rule = getPreferCdevReadRule();
      assert.ok(rule.includes("COOLDOWN ESCAPE VALVE"));
      assert.ok(rule.includes("one-time cooldown read"));
    });
  });

  describe("shouldBlockGrep", () => {
    it("blocks grep on source paths", () => {
      assert.ok(shouldBlockGrep("function", "src"));
      assert.ok(shouldBlockGrep("TODO", "src/**/*.ts"));
      assert.ok(shouldBlockGrep("export", "lib", "*.ts"));
    });

    it("blocks grep with no scope", () => {
      assert.ok(shouldBlockGrep("foo", ""));
    });

    it("does not block grep outside the project", () => {
      assert.equal(shouldBlockGrep("foo", "/etc"), undefined);
      assert.equal(shouldBlockGrep("foo", "~/.config"), undefined);
    });

    it("does not block grep in excluded directories", () => {
      assert.equal(shouldBlockGrep("foo", "node_modules/bar"), undefined);
      assert.equal(shouldBlockGrep("foo", ".git/hooks"), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockGrep("TODO", "src");
      assert.ok(result);
      assert.ok(result!.reason.includes("search for 'TODO' in src"));
      assert.ok(result!.reason.includes("cdev({ quick:true"));
    });
  });

  describe("shouldBlockGlob", () => {
    it("blocks source-like glob patterns", () => {
      assert.ok(shouldBlockGlob("src/**/*.ts"));
      assert.ok(shouldBlockGlob("**/*.json"));
      assert.ok(shouldBlockGlob("config/*.yaml"));
    });

    it("does not block binary glob patterns", () => {
      assert.equal(shouldBlockGlob("**/*.png"), undefined);
      assert.equal(shouldBlockGlob("**/*.zip"), undefined);
    });

    it("does not block glob outside the project", () => {
      assert.equal(shouldBlockGlob("/etc/**/*.conf"), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockGlob("src/**/*.ts");
      assert.ok(result);
      assert.ok(result!.reason.includes("list files matching 'src/**/*.ts'"));
      assert.ok(result!.reason.includes("cdev({ quick:true"));
    });
  });

  describe("shouldBlockBash", () => {
    it("blocks file read commands", () => {
      assert.ok(shouldBlockBash("cat src/index.ts"));
      assert.ok(shouldBlockBash("head -n 20 config.yaml"));
      assert.ok(shouldBlockBash("tail -f lib/foo.py"));
    });

    it("blocks search and discovery commands", () => {
      assert.ok(shouldBlockBash("grep -r 'TODO' src"));
      assert.ok(shouldBlockBash("rg 'function' src"));
      assert.ok(shouldBlockBash("find src -name '*.ts'"));
      assert.ok(shouldBlockBash("git ls-files"));
      assert.ok(shouldBlockBash("git diff HEAD~1"));
      assert.ok(shouldBlockBash("ls -R src"));
    });

    it("does not block build or run commands", () => {
      assert.equal(shouldBlockBash("npm test"), undefined);
      assert.equal(shouldBlockBash("npm run build"), undefined);
      assert.equal(shouldBlockBash("node dist/index.js"), undefined);
      assert.equal(shouldBlockBash("git status"), undefined);
      assert.equal(shouldBlockBash("cd src && pwd"), undefined);
    });

    it("does not block bash reading external files", () => {
      assert.equal(shouldBlockBash("cat /etc/hosts"), undefined);
      assert.equal(shouldBlockBash("cat ~/.bashrc"), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockBash("cat src/index.ts");
      assert.ok(result);
      assert.ok(result!.reason.includes("Direct bash 'cat src/index.ts' is disabled"));
      assert.ok(result!.reason.includes("cdev({ quick:true"));
    });
  });

  describe("shouldBlockDiff", () => {
    it("blocks direct diff tool calls", () => {
      assert.ok(shouldBlockDiff("HEAD~1"));
      assert.ok(shouldBlockDiff("main..feature"));
    });

    it("does not block empty diff specs", () => {
      assert.equal(shouldBlockDiff(""), undefined);
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockDiff("HEAD~1");
      assert.ok(result);
      assert.ok(result!.reason.includes("/cdev review HEAD~1"));
      assert.ok(result!.reason.includes("cdev({ review:true, diffSpec:\"HEAD~1\""));
    });
  });

  describe("shouldBlockRepeatedRead", () => {
    it("blocks repeated reads within the same turn", () => {
      const seen = new Set<string>();
      seen.add("src/foo.ts");
      const result = shouldBlockRepeatedRead("src/foo.ts", seen);
      assert.ok(result);
      assert.ok(result!.reason.includes("already used this turn"));
    });

    it("does not block first read", () => {
      const seen = new Set<string>();
      assert.equal(shouldBlockRepeatedRead("src/foo.ts", seen), undefined);
    });
  });

  describe("cooldown state", () => {
    it("tracks cooldown via registerReadEnforcement mock events", () => {
      const events: { event: string; args: unknown[] }[] = [];
      const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
      const pi = {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
          events.push({ event, args: [] });
          handlers[event] = handlers[event] || [];
          handlers[event].push(handler);
        },
        sendUserMessage: (_message: string, _options?: Record<string, unknown>) => {
          // no-op
        },
      };
      registerReadEnforcement(pi as never);
      const turnStart = handlers["turn_start"]?.[0];
      const toolCall = handlers["tool_call"]?.[0];
      assert.ok(turnStart);
      assert.ok(toolCall);

      turnStart();

      const ctx = { cwd: process.cwd() } as never;
      let blocked = 0;
      for (let i = 0; i < 2; i++) {
        const result = toolCall({ toolName: "read", input: { path: `src/file${i}.ts` } }, ctx);
        if (result && (result as { block?: boolean }).block) blocked++;
      }
      assert.equal(blocked, 2);

      // Third read should be allowed because cooldown threshold (2) was reached.
      const cooldownRead = toolCall({ toolName: "read", input: { path: "src/rescue.ts" } }, ctx);
      assert.equal(cooldownRead, undefined);

      // Fourth read should be blocked again.
      const afterCooldown = toolCall({ toolName: "read", input: { path: "src/after.ts" } }, ctx);
      assert.ok(afterCooldown);
      assert.ok((afterCooldown as { block?: boolean }).block);
    });

    it("resets cooldown after a cdev tool result", () => {
      const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
      const pi = {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
          handlers[event] = handlers[event] || [];
          handlers[event].push(handler);
        },
        sendUserMessage: () => undefined,
      };
      registerReadEnforcement(pi as never);
      const turnStart = handlers["turn_start"]?.[0];
      const toolCall = handlers["tool_call"]?.[0];
      const toolResult = handlers["tool_result"]?.[0];
      assert.ok(turnStart && toolCall && toolResult);

      turnStart();
      const ctx = { cwd: process.cwd() } as never;

      toolCall({ toolName: "read", input: { path: "src/a.ts" } }, ctx);
      toolCall({ toolName: "read", input: { path: "src/b.ts" } }, ctx);

      toolResult({ toolName: "cdev", result: { findings: [{ observation: "ok" }] } }, ctx);

      // After a successful cdev result the block counter is reset, so the next read blocks.
      const r1 = toolCall({ toolName: "read", input: { path: "src/c.ts" } }, ctx);
      assert.ok((r1 as { block?: boolean }).block);
      // Second block since cdev reaches threshold (2) and arms cooldown.
      const r2 = toolCall({ toolName: "read", input: { path: "src/d.ts" } }, ctx);
      assert.ok((r2 as { block?: boolean }).block);
      // Third read is the cooldown escape valve.
      const r3 = toolCall({ toolName: "read", input: { path: "src/e.ts" } }, ctx);
      assert.equal(r3, undefined);
    });
  });

  describe("shouldBlockIntrospection", () => {
    it("blocks known introspection tools on project paths", () => {
      assert.ok(shouldBlockIntrospection("typescript", { path: "src/index.ts" }));
      assert.ok(shouldBlockIntrospection("symbols", { file: "lib/foo.py" }));
      assert.ok(shouldBlockIntrospection("trace", { pattern: "src/**/*.ts" }));
    });

    it("does not block unknown tools", () => {
      assert.equal(shouldBlockIntrospection("npm", { path: "package.json" }), undefined);
      assert.equal(shouldBlockIntrospection("docker", {}), undefined);
    });

    it("does not block introspection tools targeting external files", () => {
      assert.equal(shouldBlockIntrospection("typescript", { path: "/etc/foo.ts" }), undefined);
      assert.equal(shouldBlockIntrospection("python_ast", { path: "~/.config/bar.py" }), undefined);
    });

    it("blocks introspection tools with no project path", () => {
      assert.ok(shouldBlockIntrospection("analyze", {}));
    });

    it("includes an actionable reason", () => {
      const result = shouldBlockIntrospection("typescript", { path: "src/index.ts" });
      assert.ok(result);
      assert.ok(result!.reason.includes("Direct 'typescript' is disabled"));
      assert.ok(result!.reason.includes("cdev({ quick:true"));
    });
  });
});
