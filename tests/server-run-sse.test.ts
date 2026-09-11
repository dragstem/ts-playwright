import http from "node:http";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let storageDir: string;
let prev: Record<string, string | undefined> = {};
let baseUrl = "";

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-sse-"));
  const repoProjects = path.resolve(process.cwd(), "storage", "projects");
  if (existsSync(repoProjects)) {
    cpSync(repoProjects, path.join(storageDir, "projects"), { recursive: true });
  }
  prev = {
    APP_STORAGE_DIR: process.env.APP_STORAGE_DIR,
    APP_DOCKER_IMAGE: process.env.APP_DOCKER_IMAGE,
    APP_RUN_TIMEOUT_MS: process.env.APP_RUN_TIMEOUT_MS
  };
  process.env.APP_STORAGE_DIR = storageDir;
  process.env.APP_DOCKER_IMAGE = "ts-playwright/nonexistent-for-test:0"; // background exec fails fast
  process.env.APP_RUN_TIMEOUT_MS = "4000"; // keep teardown quick
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 30000); // real listen + scenario copy under full-suite load can exceed the 10s default

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(storageDir, { recursive: true, force: true });
}, 30000);

function readUntilSnapshot(runId: string): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const req = http.get(`${baseUrl}/api/runs/${runId}/stream`, { agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        data += chunk;
        // Wait for a complete SSE frame (terminated by a blank line) containing the snapshot.
        if (data.includes("event: run.snapshot") && data.includes("\n\n")) {
          req.destroy();
          resolve(data);
        }
      });
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(data));
    setTimeout(() => {
      req.destroy();
      resolve(data);
    }, 2000);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe("run SSE stream (Phase 3 / 3.M3)", () => {
  it("404s for an unknown run", async () => {
    const res = await app.inject({ method: "GET", url: "/api/runs/nope/stream" });
    expect(res.statusCode).toBe(404);
  });

  it("streams a snapshot for a real run", async () => {
    const scns = await app.inject({ method: "GET", url: "/api/projects/proj_demo/scenarios" });
    expect(scns.statusCode).toBe(200);
    const scenarioId = (scns.json() as Array<{ id: string }>)[0]?.id;
    expect(scenarioId).toBeTruthy();

    const run = await app.inject({ method: "POST", url: `/api/scenarios/${scenarioId}/run`, payload: {} });
    expect(run.statusCode).toBe(200);
    const runId = run.json().id as string;
    expect(runId).toBeTruthy();

    const data = await readUntilSnapshot(runId);
    expect(data).toContain("event: run.snapshot");
    expect(data).toContain(runId);
  }, 20000);

  it("broadcasts execution status across all runs on the global stream", async () => {
    const scns = await app.inject({ method: "GET", url: "/api/projects/proj_demo/scenarios" });
    const scenarioId = (scns.json() as Array<{ id: string }>)[0]?.id;
    expect(scenarioId).toBeTruthy();

    let body = "";
    const req = http.get(`${baseUrl}/api/stream/execution`, { agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
    });
    req.on("error", () => {
      /* connection torn down at teardown */
    });

    try {
      // Subscribe before triggering, so the status delta is observed live (not just in the snapshot).
      expect(await waitUntil(() => body.includes("event: execution.snapshot"), 4000)).toBe(true);

      const run = await app.inject({ method: "POST", url: `/api/scenarios/${scenarioId}/run`, payload: {} });
      expect(run.statusCode).toBe(200);

      expect(await waitUntil(() => body.includes("event: execution.run"), 10000)).toBe(true);
      expect(body).toContain("event: execution.snapshot");
      expect(body).toContain("event: execution.active");
    } finally {
      req.destroy();
    }
  }, 25000);

  it("404s for an unknown batch stream", async () => {
    const res = await app.inject({ method: "GET", url: "/api/batches/nope/stream" });
    expect(res.statusCode).toBe(404);
  });

  it("streams a batch snapshot and forwards member deltas", async () => {
    // A cookie is needed for the authenticated /complete top-up used to emit a deterministic delta.
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { login: "sse-admin@x.com", password: "supersecret1" }
    });
    const setCookie = reg.headers["set-cookie"];
    const cookie = String(Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? "")).split(";")[0];

    const scns = await app.inject({ method: "GET", url: "/api/projects/proj_demo/scenarios" });
    const scenarioId = (scns.json() as Array<{ id: string }>)[0]?.id;
    expect(scenarioId).toBeTruthy();

    // A repeated run creates a batch (shared batch_id).
    const created = await app.inject({
      method: "POST",
      url: `/api/scenarios/${scenarioId}/run`,
      headers: { cookie },
      payload: { amount_times_to_run: 2 }
    });
    expect(created.statusCode).toBe(200);
    const batchId = (created.json() as { batch_id: string | null }).batch_id;
    expect(batchId).toBeTruthy();

    let body = "";
    const req = http.get(`${baseUrl}/api/batches/${batchId}/stream`, { agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
    });
    req.on("error", () => {
      /* torn down below */
    });

    try {
      expect(await waitUntil(() => body.includes("event: batch.snapshot"), 5000)).toBe(true);
      expect(body).toContain(String(batchId));
      // Top up the batch AFTER subscribing so the fresh members emit deltas we are guaranteed to see.
      const topup = await app.inject({ method: "POST", url: `/api/batches/${batchId}/complete`, headers: { cookie } });
      expect(topup.statusCode).toBe(200);
      expect((topup.json() as { added: number }).added).toBeGreaterThan(0);
      expect(await waitUntil(() => body.includes("event: batch.run"), 12000)).toBe(true);
      expect(body).toContain("event: batch.aggregate");
    } finally {
      req.destroy();
    }
  }, 30000);

  it("pushes a readiness snapshot on the health stream", async () => {
    let body = "";
    const req = http.get(`${baseUrl}/api/stream/health`, { agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
    });
    req.on("error", () => {
      /* torn down below */
    });
    try {
      expect(await waitUntil(() => body.includes("event: health"), 5000)).toBe(true);
      expect(body).toContain('"checks"');
      expect(body).toMatch(/"ready":(true|false)/);
    } finally {
      req.destroy();
    }
  }, 15000);
});
