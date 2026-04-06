import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server root page", () => {
  let storageDir = "";
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(path.join(os.tmpdir(), "ts-playwright-server-test-"));
    previousStorageDir = process.env.APP_STORAGE_DIR;
    process.env.APP_STORAGE_DIR = storageDir;
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

  it("serves the root page as html", async () => {
    const { createServer } = await import("../apps/server/src/app");
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/"
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<!DOCTYPE html>");
      expect(response.body).toContain("<h1>Projects</h1>");
    } finally {
      await app.close();
    }
  });
});
