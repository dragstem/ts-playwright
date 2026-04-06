import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PACKAGE_FILENAME,
  RUNS_DIRNAME,
  STORAGE_SCHEMA_VERSION
} from "./constants";

export function ensureStorageLayout(storageDir: string): void {
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(path.join(storageDir, "projects"), { recursive: true });
  writeFileSync(path.join(storageDir, ".schema_version"), String(STORAGE_SCHEMA_VERSION), "utf8");
}

export function normalizeFolderPath(folderPath: string | null | undefined): string {
  if (!folderPath) {
    return "";
  }
  const cleaned = folderPath.replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) {
    return "";
  }
  const parts = cleaned.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes(":")) {
      throw new Error("Invalid folder path");
    }
    normalized.push(part);
  }
  return normalized.join("/");
}

export function safeJoin(root: string, relativePath: string): string {
  const rootResolved = path.resolve(root);
  const fullPath = path.resolve(rootResolved, relativePath);
  if (fullPath !== rootResolved && !fullPath.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("Path escapes project root");
  }
  return fullPath;
}

export function projectRootDir(storageDir: string, projectId: string): string {
  const projectDir = path.join(storageDir, "projects", projectId);
  mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

export function folderDir(storageDir: string, projectId: string, folderPath: string): string {
  const normalized = normalizeFolderPath(folderPath);
  const target = safeJoin(projectRootDir(storageDir, projectId), normalized);
  mkdirSync(target, { recursive: true });
  return target;
}

export function isScenarioDir(targetPath: string): boolean {
  return existsSync(path.join(targetPath, PACKAGE_FILENAME));
}

export function slugify(text: string): string {
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "scenario";
}

export function uniqueChildDir(parentDir: string, baseName: string): string {
  const candidate = path.join(parentDir, baseName);
  if (!existsSync(candidate)) {
    return candidate;
  }
  let index = 2;
  while (true) {
    const nextCandidate = path.join(parentDir, `${baseName}-${index}`);
    if (!existsSync(nextCandidate)) {
      return nextCandidate;
    }
    index += 1;
  }
}

export function scenarioDirFromPackage(packagePath: string): string {
  return path.dirname(packagePath);
}

export function scenarioPackagePath(scenarioDir: string): string {
  return path.join(scenarioDir, PACKAGE_FILENAME);
}

export function runArtifactsDir(scenarioDir: string, runId: string): string {
  const artifactsDir = path.join(scenarioDir, RUNS_DIRNAME, runId);
  mkdirSync(artifactsDir, { recursive: true });
  return artifactsDir;
}
