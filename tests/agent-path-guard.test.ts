import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideDir } from "../apps/agent/src/path-guard";

const base = path.resolve(path.join("ts-playwright-agent-tmp"));

describe("assertInsideDir (Phase 0 / P0-T06)", () => {
  it("allows the base directory itself", () => {
    expect(assertInsideDir(base, base)).toBe(base);
  });

  it("allows a file inside the base directory", () => {
    const inside = path.join(base, "scenario.spec.ts");
    expect(assertInsideDir(inside, base)).toBe(inside);
  });

  it("allows a nested file inside the base directory", () => {
    const inside = path.join(base, "replay_1", "stdout.log");
    expect(assertInsideDir(inside, base)).toBe(inside);
  });

  it("rejects a parent-traversal escape", () => {
    expect(() => assertInsideDir(path.join(base, "..", "evil.txt"), base)).toThrow(/outside/);
  });

  it("rejects an unrelated absolute path", () => {
    expect(() => assertInsideDir(path.resolve(path.sep, "etc", "passwd"), base)).toThrow(/outside/);
  });

  it("rejects a sibling directory that shares the name prefix", () => {
    expect(() => assertInsideDir(base + "-evil" + path.sep + "x", base)).toThrow(/outside/);
  });
});
