import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCENARIO_FILE_NAME } from "@ts-playwright/shared";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const AdmZip = require("../apps/server/node_modules/adm-zip");

// Project/environment creation (project-creation wizard) + the pre-run config check that the run
// preview now returns.
let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : (raw ?? "")).split(";")[0];
}

// Write a scenario package on disk (discovered on the next readState) whose scenario.spec.ts source
// references a server token, so detectRequiredServerInputs picks it up.
function writeScenario(dirName: string, source: string): void {
  const scenarioDir = path.join(storageDir, "projects", "proj_demo", "suite_tok", dirName);
  mkdirSync(scenarioDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        scenario_type: "playwright-test-ts",
        project_id: "proj_demo",
        env_id: "staging",
        folder_path: "suite_tok",
        scenario_name: "Needs 2FA",
        scenario_slug: "needs_2fa",
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
  zip.addFile(SCENARIO_FILE_NAME, Buffer.from(source));
  zip.writeZip(path.join(scenarioDir, "package.zip"));
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-projects-"));
  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { login: "admin@x.com", password: "supersecret1" } });
  cookie = cookieFrom(reg);
});

afterEach(async () => {
  await app?.close();
  if (prev.APP_STORAGE_DIR === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prev.APP_STORAGE_DIR;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("project + environment creation", () => {
  it("creates a project (minting an id) and lists it", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "My Project" } });
    expect(res.statusCode).toBe(200);
    const created = res.json() as { id: string; name: string };
    expect(created.id).toMatch(/^proj_/);
    expect(created.name).toBe("My Project");

    const list = (await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } })).json() as Array<{ id: string }>;
    expect(list.some((p) => p.id === created.id)).toBe(true);
  });

  it("creates an environment for a project and 404s for an unknown project", async () => {
    const env = await app.inject({
      method: "POST",
      url: "/api/projects/proj_demo/environments",
      headers: { cookie },
      payload: { name: "prod", base_url: "https://prod.example.com", is_default: true }
    });
    expect(env.statusCode).toBe(200);
    const created = env.json() as { id: string; is_default: boolean; project_id: string };
    expect(created.id).toMatch(/^env_/);
    expect(created.is_default).toBe(true);
    expect(created.project_id).toBe("proj_demo");

    const bad = await app.inject({
      method: "POST",
      url: "/api/projects/nope/environments",
      headers: { cookie },
      payload: { name: "x", base_url: "https://x.example.com" }
    });
    expect(bad.statusCode).toBe(404);
  });
});

describe("pre-run config check (run preview)", () => {
  it("flags a {server_2faotp} the project has not configured", async () => {
    writeScenario("needs2fa", 'import { test } from "@playwright/test";\ntest("s", async () => { const code = "{server_2faotp}"; });\n');
    const scns = (await app.inject({ method: "GET", url: "/api/projects/proj_demo/scenarios", headers: { cookie } })).json() as Array<{ id: string }>;
    const scenarioId = scns[0]?.id;
    expect(scenarioId).toBeTruthy();

    const preview = await app.inject({ method: "POST", url: `/api/scenarios/${scenarioId}/run/preview`, headers: { cookie }, payload: {} });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as { required_server_inputs: string[]; missing_server_inputs: string[] };
    expect(body.required_server_inputs).toContain("server_2faotp");
    expect(body.missing_server_inputs).toContain("server_2faotp");
  });

  it("reports no missing inputs for a token-free scenario", async () => {
    writeScenario("plain", 'import { test } from "@playwright/test";\ntest("s", async () => {});\n');
    const scns = (await app.inject({ method: "GET", url: "/api/projects/proj_demo/scenarios", headers: { cookie } })).json() as Array<{ id: string }>;
    const preview = await app.inject({ method: "POST", url: `/api/scenarios/${scns[0]?.id}/run/preview`, headers: { cookie }, payload: {} });
    expect((preview.json() as { missing_server_inputs: string[] }).missing_server_inputs).toEqual([]);
  });
});
