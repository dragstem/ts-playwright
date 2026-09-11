import path from "node:path";

// Phase 0 / P0-T06: confine agent IPC file operations to a base directory (the agent temp dir).
// Rejects `..` traversal, absolute outside paths, and sibling directories that merely share a
// name prefix (e.g. base `ts-playwright-agent` vs `ts-playwright-agent-evil`). Returns the
// resolved absolute path on success so callers can use it directly.
export function assertInsideDir(target: string, baseDir: string): string {
  const resolved = path.resolve(String(target ?? ""));
  const base = path.resolve(baseDir);
  const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  if (normalizedResolved !== normalizedBase && !normalizedResolved.startsWith(normalizedBase + path.sep)) {
    throw new Error("Path is outside the allowed agent directory");
  }
  return resolved;
}
