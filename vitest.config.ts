import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@ts-playwright/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@ts-playwright/runner": path.resolve(__dirname, "packages/runner/src/index.ts")
    }
  }
});
