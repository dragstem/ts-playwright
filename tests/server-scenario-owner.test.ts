import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

// Server-attested scenario ownership (Phase 4 / 4.2). An authenticated upload (PAT/session) records
// the real uploader as created_by, overriding the agent's client-claimed recorded_by, and audits it.
let app: FastifyInstance;
let storageDir = "";
let prevStorageDir: string | undefined;

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

function uploadPayload(
  recordedBy: string,
  source = "import { test } from '@playwright/test';\ntest('x', async () => {});\n"
): { payload: Buffer; contentType: string } {
  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        scenario_type: "playwright-test-ts",
        project_id: "proj_demo",
        env_id: "staging",
        folder_path: "uploads",
        scenario_name: "Owned Scenario",
        scenario_slug: "owned_scenario",
        recorded_at: "2026-01-01T00:00:00.000Z",
        recorded_by: recordedBy,
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
  zip.addFile("scenario.spec.ts", Buffer.from(source));
  const boundary = "----ts-playwright-owner-test";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scenario.zip"\r\nContent-Type: application/zip\r\n\r\n`
    ),
    zip.toBuffer(),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-owner-"));
  prevStorageDir = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  if (prevStorageDir === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prevStorageDir;
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("scenario upload ownership (Phase 4 / 4.2)", () => {
  it("stamps the authenticated uploader as created_by and audits it", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "owner@example.com", password: "supersecret1" }
    });
    const cookie = cookieFrom(reg);

    const { payload, contentType } = uploadPayload("agent-config-claimed");
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/proj_demo/scenarios/upload?path=uploads",
      headers: { "content-type": contentType, cookie },
      payload
    });
    expect(upload.statusCode).toBe(200);
    // created_by reflects the authenticated user, NOT the agent's claimed recorded_by.
    expect(upload.json().created_by).toBe("owner@example.com");

    const audit = await app.inject({ method: "GET", url: "/api/auth/audit", headers: { cookie } });
    expect(audit.statusCode).toBe(200);
    const entries = audit.json() as Array<{ action: string; actor_login: string }>;
    expect(entries.some((e) => e.action === "scenario.upload" && e.actor_login === "owner@example.com")).toBe(true);
  });

  it("keeps the client-claimed recorded_by when unauthenticated", async () => {
    const { payload, contentType } = uploadPayload("agent-config-claimed");
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/proj_demo/scenarios/upload?path=uploads",
      headers: { "content-type": contentType },
      payload
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().created_by).toBe("agent-config-claimed");
  });

  it("accepts scenarios that navigate to a different domain", async () => {
    const { payload, contentType } = uploadPayload(
      "agent-config-claimed",
      "import { test } from '@playwright/test';\ntest('external navigation', async ({ page }) => { await page.goto('https://www.google.com'); });\n"
    );
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/proj_demo/scenarios/upload?path=uploads",
      headers: { "content-type": contentType },
      payload
    });

    expect(upload.statusCode).toBe(200);
  });
});
