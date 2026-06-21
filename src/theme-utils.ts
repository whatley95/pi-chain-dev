/**
 * Shared ANSI / theme background utilities for pi-chain-dev.
 *
 * Extracted from render.ts and index.ts to eliminate duplicated
 * ANSI fallback logic across both files.
 */

/** ANSI background color codes used as fallback when theme.bg() token lookup fails. */
export const ANSI_BG_COLORS: Record<string, string> = {
  toolPendingBg: "\x1b[43m",
  toolSuccessBg: "\x1b[42m",
  toolErrorBg: "\x1b[41m",
  toolStageBg: "\x1b[100m",
};

/**
 * Wrap text in background styling — either from a Theme object (TUI) or ANSI fallback.
 *
 * @param token  The theme.bg() token to try (e.g. "toolPendingBg").
 * @param text   The text to wrap.
 * @param theme  Optional TUI Theme object. If provided, theme.bg(token, text) is tried first.
 * @param themed If false, text is returned unstyled (passthrough).
 */
export function bg(
  token: string,
  text: string,
  theme?: { bg: (t: string, s: string) => string },
  themed = false,
): string {
  if (!themed) return text;
  if (theme) {
    try {
      const result = theme.bg(token, text);
      if (result !== text) return result;
    } catch {
      // token not available in theme — fall through to ANSI
    }
  }
  const ansi = ANSI_BG_COLORS[token];
  return ansi ? `${ansi} ${text} \x1b[0m` : text;
}
