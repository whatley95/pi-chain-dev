/**
 * Custom multiRead tool for cdev scouts.
 *
 * Allows a scout to read multiple files in a single tool call. The child Pi
 * process that runs the scout is started with --tools read,bash,ls,grep,rg,find,cat.
 * We register `multiRead` as an extension tool in the child session so the scout
 * can use it, and we also register it in the parent so the tool schema is known.
 *
 * The tool takes an array of { path, offset?, limit? } entries and returns the
 * concatenated contents, prefixed with file markers, in one tool result.
 */

import { promises as fs } from "node:fs";
import { resolve, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_TOTAL_CHARS = 50_000;
const MAX_FILES = 10;

export const multiReadSchema = {
  type: "object",
  properties: {
    files: {
      type: "array",
      description: `Array of files to read in parallel (max ${MAX_FILES})`,
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read" },
          offset: { type: "integer", description: "1-based starting line" },
          limit: { type: "integer", description: "Maximum number of lines to read" },
        },
        required: ["path"],
      },
    },
  },
  required: ["files"],
};

export type MultiReadInput = {
  files: Array<{ path: string; offset?: number; limit?: number }>;
};

async function readOne(
  cwd: string,
  entry: MultiReadInput["files"][number],
  signal?: AbortSignal,
): Promise<{ path: string; content: string; error?: string }> {
  const abs = resolve(cwd, entry.path);
  const rel = relative(cwd, abs);
  if (signal?.aborted) {
    return { path: rel, content: "", error: "Aborted" };
  }
  try {
    let content = await fs.readFile(abs, "utf-8");
    if (typeof entry.offset === "number" && entry.offset > 0) {
      const lines = content.split("\n");
      const start = Math.max(0, entry.offset - 1);
      const end = typeof entry.limit === "number" && entry.limit > 0
        ? Math.min(lines.length, start + entry.limit)
        : lines.length;
      content = lines.slice(start, end).join("\n");
    } else if (typeof entry.limit === "number" && entry.limit > 0) {
      content = content.split("\n").slice(0, entry.limit).join("\n");
    }
    return { path: rel, content };
  } catch (err) {
    return { path: rel, content: "", error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerMultiReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "multiRead",
    label: "Multi Read",
    description: `Read up to ${MAX_FILES} files in a single tool call. Use this instead of multiple separate \`read\` calls to reduce round-trips. Each entry supports optional line ranges (offset/limit). Output is capped at ~${MAX_TOTAL_CHARS} characters.`,
    promptSnippet: `multiRead: read up to ${MAX_FILES} files at once`,
    promptGuidelines: [
      "Use multiRead when you need 2 or more files in the same turn.",
      "Prefer multiRead over multiple separate read calls to reduce round-trips.",
      "Do NOT use multiRead to create, modify, or delete files; it is read-only.",
    ],
    parameters: multiReadSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Aborted" }],
          details: { count: 0 },
        };
      }
      const cwd = ctx.cwd;
      const input = params as MultiReadInput;
      const files = Array.isArray(input.files) ? input.files.slice(0, MAX_FILES) : [];
      const results = await Promise.all(files.map((f) => readOne(cwd, f, signal)));

      let total = 0;
      const lines: string[] = [];
      for (const r of results) {
        if (signal?.aborted) {
          break;
        }
        const header = `--- FILE: ${r.path} ---`;
        const body = r.error ? `ERROR: ${r.error}` : r.content;
        const chunk = `${header}\n${body}`;
        if (total + chunk.length > MAX_TOTAL_CHARS) {
          lines.push(
            `--- FILE: ${r.path} ---\nERROR: output truncated by multiRead total-char limit. ` +
              "Read fewer files or use offset=N/limit=N to continue from a later line.",
          );
          break;
        }
        lines.push(chunk);
        total += chunk.length + 1;
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: results.length },
      };
    },
  });
}
