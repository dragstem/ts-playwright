import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Open the data plane by default for the pre-RBAC /api tests. The global RBAC gate itself is
    // exercised explicitly in server-rbac.test.ts (which sets APP_REQUIRE_AUTH=1). Production leaves
    // APP_REQUIRE_AUTH unset, where it defaults to ON (secure by default).
    env: { APP_REQUIRE_AUTH: "0" }
  },
  resolve: {
    alias: {
      "@ts-playwright/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@ts-playwright/runner": path.resolve(__dirname, "packages/runner/src/index.ts")
    }
  }
});
