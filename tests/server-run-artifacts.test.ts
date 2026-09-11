import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Run outputs + artifact serving (video/screenshots with a content type).
let app: FastifyInstance;
let storageDir = "";
let artifactsDir = "";
const prev: Record<string, string | undefined> = {};
const RUN_ID = "run-artifacts-1";

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-artifacts-"));
  artifactsDir = path.join(storageDir, "artifacts", RUN_ID);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(artifactsDir, "outputs.json"), JSON.stringify({ trace_id: "T-123", balance: "42.0" }), "utf8");
  writeFileSync(path.join(artifactsDir, "video.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

  const run = {
    id: RUN_ID,
    scenario_id: "scn-x",
    triggered_by: "api",
    triggered_at: "2026-02-01T00:00:00.000Z",
    status: "passed",
    outcome: "passed",
    artifacts_path: artifactsDir,
    inputs: {}
  };
  writeFileSync(
    path.join(storageDir, "app-state.json"),
    JSON.stringify({ projects: [{ id: "proj_demo", name: "Demo" }], runs: [run] }),
    "utf8"
  );

  prev.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR;
  prev.APP_REQUIRE_AUTH = process.env.APP_REQUIRE_AUTH;
  process.env.APP_STORAGE_DIR = storageDir;
  process.env.APP_REQUIRE_AUTH = "0";
  vi.resetModules();
  const { createServer } = await import("../apps/server/src/app");
  app = createServer();
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("run outputs & artifacts", () => {
  it("returns extracted outputs for a run", async () => {
    const res = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}/outputs` });
    expect(res.statusCode).toBe(200);
    expect(res.json().outputs).toEqual({ trace_id: "T-123", balance: "42.0" });
  });

  it("lists artifacts and serves a video with the right content type", async () => {
    const list = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}/artifacts` });
    expect(list.json().artifacts).toContain("video.webm");

    const video = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}/artifacts/video.webm` });
    expect(video.statusCode).toBe(200);
    expect(video.headers["content-type"]).toContain("video/webm");
    expect(video.headers["accept-ranges"]).toBe("bytes");
  });

  it("serves a byte range (206) so the video player can seek", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${RUN_ID}/artifacts/video.webm`,
      headers: { range: "bytes=0-1" }
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-1/4");
    expect(res.headers["content-length"]).toBe("2");
    expect(res.rawPayload.length).toBe(2);
  });

  it("404s outputs for an unknown run", async () => {
    const res = await app.inject({ method: "GET", url: "/api/runs/nope/outputs" });
    expect(res.statusCode).toBe(404);
  });
});
