// Stub declarations for Pi peer dependencies so the project type-checks
// without the full packages installed. These are runtime-provided packages.

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    registerTool(tool: {
      name: string;
      label?: string;
      description?: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters?: unknown;
      renderCall?: (args: unknown, theme: { fg(token: string, text: string): string; bg(token: string, text: string): string }, _context?: { cwd?: string }) => unknown;
      renderResult?: (toolResult: unknown, opts: { expanded: boolean }, theme: { fg(token: string, text: string): string; bg(token: string, text: string): string }, _context?: { cwd?: string }) => unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: (update: unknown) => void,
        ctx: ExtensionContext,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
    }): void;
    registerCommand(name: string, command: {
      description: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
    }): void;
    sendUserMessage(message: string, options?: Record<string, unknown>): void;
  }

  export interface ExtensionContext {
    cwd: string;
    model?: { id: string; provider: string; contextWindow?: number };
    modelRegistry: {
      getAvailable(): Array<{ id: string; provider: string }>;
      getAll?(): Array<{ id: string; provider: string }>;
      getProviderAuthStatus(provider: string): { configured: boolean };
      hasConfiguredAuth(model: { provider: string }): boolean;
    };
    sessionManager: {
      getHeader(): unknown;
      getBranch(): unknown[];
      getEntries(): unknown[];
    };
    ui: {
      theme: {
        fg(token: string, text: string): string;
        bg(token: string, text: string): string;
      };
      notify(message: string, level?: "info" | "warn" | "error"): void;
      select(title: string, items: string[]): Promise<string | undefined>;
      input(prompt: string): Promise<string | undefined>;
      setStatus(key: string, value: string | undefined): void;
      setWidget(key: string, value: unknown): void;
    };
    /** Get current context usage for the active model. */
    getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    /** Trigger compaction without awaiting completion. */
    compact?(options?: Record<string, unknown>): void;
  }

  export function getAgentDir(): string;
  export function keyHint(text: string): string | undefined;
}

declare module "@earendil-works/pi-tui" {
  export interface Component {
    [key: string]: unknown;
  }
  export interface Theme {
    fg(token: string, text: string): string;
    bg(token: string, text: string): string;
  }
  export interface SimpleTextProps {
    text: string;
    [key: string]: unknown;
  }
  export class SimpleText implements Component {
    [key: string]: unknown;
    constructor(props: SimpleTextProps);
  }
}

declare module "@sinclair/typebox" {
  export const Type: {
    Object(props: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
    String(options?: Record<string, unknown>): unknown;
    Boolean(options?: Record<string, unknown>): unknown;
    Integer(options?: Record<string, unknown>): unknown;
    Number(options?: Record<string, unknown>): unknown;
  };
}
