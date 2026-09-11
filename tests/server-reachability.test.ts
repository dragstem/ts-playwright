import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prevStorageDir: string | undefined;
let cookie = "";
let probe: http.Server;
let probeUrl = "";

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie ?? "");
  return raw.split(";")[0];
}

beforeAll(async () => {
  // A local stand stand-in that answers any request with 204, so a probe of it is "reachable".
  probe = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const addr = probe.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  probeUrl = `http://127.0.0.1:${port}`;

  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-reach-"));
  prevStorageDir = process.env.APP_STORAGE_DIR;
  process.env.APP_STORAGE_DIR = storageDir;
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();

  // First registration becomes admin and gives us a session cookie.
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { login: "admin@example.com", password: "supersecret1" }
  });
  cookie = cookieFrom(reg);

  // Point the seeded "staging" environment at the local probe, and add a closed-port env.
  const statePath = path.join(storageDir, "app-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const staging = state.environments.find((e: { id: string }) => e.id === "staging");
  staging.base_url = probeUrl;
  state.environments.push({
    id: "closed",
    project_id: "proj_demo",
    name: "closed",
    base_url: "http://127.0.0.1:1",
    is_default: false
  });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (prevStorageDir === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = prevStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
});

describe("environment reachability probe (Phase 3 / 3.11)", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/api/environments/staging/reachability" });
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown environment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments/does-not-exist/reachability",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports a live stand as reachable with its status code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments/staging/reachability",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ env_id: "staging", base_url: probeUrl, reachable: true, status: 204 });
    expect(typeof body.latency_ms).toBe("number");
    expect(body.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports a closed port as unreachable with an error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments/closed/reachability",
      headers: { cookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});
