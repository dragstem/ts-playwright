import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppStateSchema } from "@ts-playwright/shared";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require("adm-zip");
import { hydrateStateFromStorage } from "../apps/server/src/store";

// Fix A: readScenarioFromPackage caches the derived scenario per package by mtime, so readState no
// longer unzips every package on every call. These tests pin the two guarantees that make the cache
// safe: it stays correct across repeated reads (and can't be poisoned by callers), and it re-reads a
// package once its bytes (and thus mtime) change.

const roots: string[] = [];

function makeStorage(): string {
  const root = mkdtempSync(path.join(tmpdir(), "scenario-cache-"));
  roots.push(root);
  return root;
}

// Write projects/<proj>/<folder>/<dir>/package.zip whose metadata carries `name`.
function writePackage(storageDir: string, name: string): string {
  const scenarioDir = path.join(storageDir, "projects", "proj_demo", "folder", "scenario-a");
  mkdirSync(scenarioDir, { recursive: true });
  const packagePath = path.join(scenarioDir, "package.zip");
  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        scenario_type: "playwright-test-ts",
        project_id: "proj_demo",
        env_id: "staging",
        folder_path: "folder",
        scenario_name: name,
        scenario_slug: "scenario_a",
        recorded_at: "2026-01-01T00:00:00.000Z",
        recorded_by: "tester",
        recorded_base_url: "https://example.com",
        run_base_url: "https://example.com",
        outputs: [],
        inputs: [],
        browser: "chromium",
        headless: true,
        viewport: { width: 1280, height: 720 },
        locale: "ru-RU",
        timezone: "Europe/Riga",
        requires_auth: false,
        auth_state_ref: null
      })
    )
  );
  zip.writeZip(packagePath);
  return packagePath;
}

function hydrate(storageDir: string) {
  return hydrateStateFromStorage(storageDir, AppStateSchema.parse({}));
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scenario package cache", () => {
  it("returns the same scenario across repeated hydrations and can't be poisoned by callers", () => {
    const storageDir = makeStorage();
    writePackage(storageDir, "Cached V1");

    const first = hydrate(storageDir).scenarios;
    expect(first).toHaveLength(1);
    expect(first[0]?.name).toBe("Cached V1");

    // Mutating a returned record must not corrupt the cached copy (cache returns clones).
    first[0]!.name = "POISON";

    const second = hydrate(storageDir).scenarios;
    expect(second).toHaveLength(1);
    expect(second[0]?.name).toBe("Cached V1");
  });

  it("re-reads a package after its contents (and mtime) change", () => {
    const storageDir = makeStorage();
    const packagePath = writePackage(storageDir, "Cached V1");
    expect(hydrate(storageDir).scenarios[0]?.name).toBe("Cached V1");

    // Rewrite with new metadata and force a distinctly newer mtime so the cache entry is invalidated
    // even on filesystems with coarse timestamp resolution.
    writePackage(storageDir, "Cached V2");
    const bumped = new Date(statSync(packagePath).mtimeMs + 5000);
    utimesSync(packagePath, bumped, bumped);

    expect(hydrate(storageDir).scenarios[0]?.name).toBe("Cached V2");
  });
});
