import path from "node:path";

/**
 * Workspace containment for permission checks. Paths are resolved with the host's path rules (so `..`,
 * absolute paths and Windows drive letters all normalize) and compared structurally via `path.relative` —
 * never by string prefix, which `../` and look-alike siblings (`/w/proj-evil`) would slip past. Windows paths
 * compare case-insensitively.
 */
export function resolveResource(root: string, p: string): string {
  return path.resolve(root, p);
}

export function isWithinWorkspace(root: string, p: string): boolean {
  const norm = (x: string) => {
    const r = path.resolve(x);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(root), norm(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
