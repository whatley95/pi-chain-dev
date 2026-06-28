import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export function isPathUnderCwd(cwd: string, target: string): boolean {
  let resolvedCwd: string;
  let resolvedTarget: string;
  try {
    resolvedCwd = realpathSync(resolve(cwd));
  } catch {
    resolvedCwd = resolve(cwd);
  }
  try {
    resolvedTarget = realpathSync(resolve(target));
  } catch {
    resolvedTarget = resolve(target);
  }
  const rel = relative(resolvedCwd, resolvedTarget);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
