import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Bulk add pool items: POST /api/pools/:id/items/bulk takes one value per line, trims each, drops
// blank + duplicate lines, and auto-generates id + label.
let app: FastifyInstance;
let storageDir = "";
let cookie = "";
const prev: Record<string, string | undefined> = {};

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : (raw ?? "")).split(";")[0];
}

async function createPool(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/pools",
    headers: { cookie },
    payload: { name: "Addresses", kind: "custom", allocation_strategy: "manual", project_id: null }
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

beforeEach(async () => {
  storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-pool-bulk-"));
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

describe("bulk add pool items", () => {
  it("trims each line, drops blanks + duplicates, and auto-generates id + label", async () => {
    const poolId = await createPool();

    const res = await app.inject({
      method: "POST",
      url: `/api/pools/${poolId}/items/bulk`,
      headers: { cookie },
      // Leading/trailing whitespace, a blank line, a whitespace-only line, and a duplicate of addr_1.
      payload: { values: ["  addr_1  ", "addr_2", "", "   ", "addr_1", "addr_3\t"] }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 3 });

    const items = (await app.inject({ method: "GET", url: `/api/pools/${poolId}/items`, headers: { cookie } })).json() as Array<{
      id: string;
      value: string;
      label: string;
    }>;
    expect(items.map((item) => item.value).sort()).toEqual(["addr_1", "addr_2", "addr_3"]);
    // Every id auto-generated; labels left empty (auto).
    expect(items.every((item) => item.id.startsWith("pool_item_"))).toBe(true);
    expect(items.every((item) => item.label === "")).toBe(true);
  });

  it("rejects an all-blank payload and an unknown pool", async () => {
    const poolId = await createPool();

    const blank = await app.inject({
      method: "POST",
      url: `/api/pools/${poolId}/items/bulk`,
      headers: { cookie },
      payload: { values: ["", "   ", "\t"] }
    });
    expect(blank.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/pools/pool_does_not_exist/items/bulk",
      headers: { cookie },
      payload: { values: ["addr_1"] }
    });
    expect(missing.statusCode).toBe(404);
  });
});
