import { isAbsolute, relative, resolve, sep } from "node:path";

export function isPathUnderCwd(cwd: string, target: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedCwd, resolvedTarget);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
