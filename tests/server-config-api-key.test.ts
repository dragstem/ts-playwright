import { afterEach, describe, expect, it } from "vitest";
import { validateApiKeyRequirement } from "../apps/server/src/config";

const original = {
  NODE_ENV: process.env.NODE_ENV,
  APP_REQUIRE_API_KEY: process.env.APP_REQUIRE_API_KEY
};

afterEach(() => {
  if (original.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.NODE_ENV;
  if (original.APP_REQUIRE_API_KEY === undefined) delete process.env.APP_REQUIRE_API_KEY;
  else process.env.APP_REQUIRE_API_KEY = original.APP_REQUIRE_API_KEY;
});

describe("validateApiKeyRequirement (Phase 0 / P0-T04)", () => {
  it("throws in production with no key", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_REQUIRE_API_KEY;
    expect(() => validateApiKeyRequirement(null)).toThrow(/APP_API_KEY is required/);
    expect(() => validateApiKeyRequirement("   ")).toThrow(/APP_API_KEY is required/);
  });

  it("passes in production with a key set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_REQUIRE_API_KEY;
    expect(() => validateApiKeyRequirement("secret")).not.toThrow();
  });

  it("does not throw in development with no key", () => {
    process.env.NODE_ENV = "development";
    delete process.env.APP_REQUIRE_API_KEY;
    expect(() => validateApiKeyRequirement(null)).not.toThrow();
  });

  it("APP_REQUIRE_API_KEY=0 overrides the production requirement", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_REQUIRE_API_KEY = "0";
    expect(() => validateApiKeyRequirement(null)).not.toThrow();
  });

  it("APP_REQUIRE_API_KEY=1 forces the requirement even in development", () => {
    process.env.NODE_ENV = "development";
    process.env.APP_REQUIRE_API_KEY = "1";
    expect(() => validateApiKeyRequirement(null)).toThrow(/APP_API_KEY is required/);
  });
});
