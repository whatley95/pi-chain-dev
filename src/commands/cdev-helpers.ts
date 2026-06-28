/**
 * Shared helper functions for cdev commands.
 */

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/(^_+|_+$)/g, "");
}

export function levenshtein(a: string, b: string): number {
  if (a.length < b.length) return levenshtein(b, a);
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1).fill(0).map((_, i) => i);
  const curr: number[] = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(
        curr[j] + 1,
        prev[j + 1] + 1,
        prev[j] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
