import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prevStorage: string | undefined;
const built = existsSync(path.resolve(process.cwd(), "apps", "web", "dist", "index.html"));

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-spa-"));
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

describe("SPA serving under /app (Phase 3 / X-T04)", () => {
  it.runIf(built)("serves index.html at /app/ and falls back for client routes", async () => {
    const root = await app.inject({ method: "GET", url: "/app/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain('id="root"');

    const redirect = await app.inject({ method: "GET", url: "/app" });
    expect([301, 302]).toContain(redirect.statusCode);

    // A client-side route with no matching file falls back to index.html.
    const clientRoute = await app.inject({ method: "GET", url: "/app/projects" });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.body).toContain('id="root"');
  });

  it("keeps the global 404 intact for unknown API routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/totally-unknown-route" });
    expect(res.statusCode).toBe(404);
  });
});
