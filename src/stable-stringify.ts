/**
 * Stable stringification for deduplication and hashing.
 */

export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const objValue = value as object;
  if (seen.has(objValue)) {
    return '"<circular>"';
  }
  seen.add(objValue);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`)
    .join(",")}}`;
}
