/**
 * Utilities for keeping displayed text within a safe terminal width.
 *
 * Pi's TUI crashes when a rendered line exceeds the terminal width. cdev
 * can emit long lines (file contents, JSON evidence, URLs, minified code),
 * so we wrap them before returning text to the parent Pi session.
 */

const DEFAULT_MAX_WIDTH = 120;

/**
 * Wrap a line at word boundaries when possible, falling back to hard wrapping
 * for tokens longer than maxWidth. Preserves existing newlines.
 */
export function wrapText(text: string, maxWidth = DEFAULT_MAX_WIDTH): string {
  if (!text) return text;
  return text.split("\n").map((line) => wrapLine(line, maxWidth)).join("\n");
}

function wrapLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) return line;

  const segments: string[] = [];
  let start = 0;

  while (start < line.length) {
    if (start + maxWidth >= line.length) {
      segments.push(line.slice(start));
      break;
    }

    let end = start + maxWidth;
    const spaceIndex = line.lastIndexOf(" ", end);
    if (spaceIndex > start) {
      end = spaceIndex;
      segments.push(line.slice(start, end));
      start = end + 1;
    } else {
      segments.push(line.slice(start, end));
      start = end;
    }
  }

  return segments.join("\n");
}

/**
 * Pretty-print JSON when possible, then wrap to a safe width.
 * This keeps JSON readable while preventing ultra-long lines from crashing
 * the TUI.
 */
export function safeDisplayText(text: string, maxWidth = DEFAULT_MAX_WIDTH): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return wrapText(JSON.stringify(parsed, null, 2), maxWidth);
    } catch {
      // not valid JSON; fall through to plain wrapping
    }
  }
  return wrapText(text, maxWidth);
}
