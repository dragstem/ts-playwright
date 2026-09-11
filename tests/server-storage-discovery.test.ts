import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

describe("server scenario discovery from storage", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-storage-discovery-test-"));
    previousStorageDir = process.env.APP_STORAGE_DIR;
    process.env.APP_STORAGE_DIR = storageDir;

    const scenarioDir = path.join(
      storageDir,
      "projects",
      "proj_demo",
      "folder",
      "nested",
      "scenario-discovered"
    );
    mkdirSync(scenarioDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile(
      "metadata.json",
      Buffer.from(
        JSON.stringify(
          {
            schema_version: 2,
            scenario_type: "playwright-test-ts",
            project_id: "proj_demo",
            env_id: "staging",
            folder_path: "folder/nested",
            scenario_name: "Discovered Scenario",
            scenario_slug: "discovered_scenario",
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
          },
          null,
          2
        ),
        "utf8"
      )
    );
    zip.addFile("scenario.spec.ts", Buffer.from("import { test } from '@playwright/test';\ntest('x', async () => {});\n"));
    zip.writeZip(path.join(scenarioDir, "package.zip"));

    vi.resetModules();
  });

  afterEach(() => {
    if (previousStorageDir === undefined) {
      delete process.env.APP_STORAGE_DIR;
    } else {
      process.env.APP_STORAGE_DIR = previousStorageDir;
    }
    vi.resetModules();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("discovers committed scenarios even when app-state has no scenarios", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/projects/proj_demo/scenarios"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          project_id: "proj_demo",
          env_id: "staging",
          name: "Discovered Scenario",
          slug: "discovered_scenario",
          folder_path: "folder/nested",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          status: "active",
          package_path: path.join(
            storageDir,
            "projects",
            "proj_demo",
            "folder",
            "nested",
            "scenario-discovered",
            "package.zip"
          )
        })
      ]);
    } finally {
      await app.close();
    }
  });

  it("does not duplicate a scenario uploaded after the package is written to storage", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();
    const zip = new AdmZip();
    zip.addFile(
      "metadata.json",
      Buffer.from(
        JSON.stringify(
          {
            schema_version: 2,
            scenario_type: "playwright-test-ts",
            project_id: "proj_demo",
            env_id: "staging",
            folder_path: "uploads",
            scenario_name: "Uploaded Scenario",
            scenario_slug: "uploaded_scenario",
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
          },
          null,
          2
        ),
        "utf8"
      )
    );
    zip.addFile("scenario.spec.ts", Buffer.from("import { test } from '@playwright/test';\ntest('x', async () => {});\n"));

    const boundary = "----ts-playwright-upload-test";
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scenario.zip"\r\nContent-Type: application/zip\r\n\r\n`
      ),
      zip.toBuffer(),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    try {
      const uploadResponse = await app.inject({
        method: "POST",
        url: "/api/projects/proj_demo/scenarios/upload?path=uploads",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`
        },
        payload
      });
      expect(uploadResponse.statusCode).toBe(200);

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/projects/proj_demo/scenarios"
      });
      expect(listResponse.statusCode).toBe(200);

      const scenarios = listResponse.json();
      const uploaded = uploadResponse.json();
      expect(scenarios).toHaveLength(2);
      expect(scenarios.filter((scenario: { package_path: string }) => scenario.package_path === uploaded.package_path)).toHaveLength(1);
      expect(scenarios.filter((scenario: { name: string }) => scenario.name === "Uploaded Scenario")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
