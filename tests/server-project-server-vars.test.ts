import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prevStorage: string | undefined;

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-psv-"));
  prevStorage = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (prevStorage === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prevStorage;
  rmSync(storageDir, { recursive: true, force: true });
});

const URL = "/api/projects/proj_demo/server-vars";

describe("project-scoped server_* (Phase 2 / 2.M3)", () => {
  it("defaults to empty and 404s for unknown projects", async () => {
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ project_id: "proj_demo", server_username: "", has_password: false, has_2faotp: false });
    expect((await app.inject({ method: "GET", url: "/api/projects/nope/server-vars" })).statusCode).toBe(404);
  });

  it("upserts write-only and masks secrets", async () => {
    const set = await app.inject({
      method: "POST",
      url: URL,
      payload: { server_username: "proj-user", server_password: "proj-pass", server_2faotp: "JBSWY3DPEHPK3PXP", server_merchant: "acme", extra: { server_region: "eu" } }
    });
    expect(set.statusCode).toBe(200);
    const masked = set.json();
    expect(masked.server_username).toBe("proj-user");
    expect(masked.server_merchant).toBe("acme");
    expect(masked.has_password).toBe(true);
    expect(masked.has_2faotp).toBe(true);
    expect(masked.extra).toMatchObject({ server_region: "eu" });
    // Never leaks the actual secret values.
    expect(JSON.stringify(masked)).not.toContain("proj-pass");
    expect(JSON.stringify(masked)).not.toContain("JBSWY3DPEHPK3PXP");

    // Empty password keeps the stored one (write-only).
    const keep = await app.inject({ method: "POST", url: URL, payload: { server_username: "proj-user-2", server_password: "" } });
    expect(keep.json().has_password).toBe(true);
    expect(keep.json().server_username).toBe("proj-user-2");
  });

  it("deletes the project server vars", async () => {
    expect((await app.inject({ method: "DELETE", url: URL })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: URL })).json().has_password).toBe(false);
  });
});
