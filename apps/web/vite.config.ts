import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

// The SPA is served under /app/ by Fastify in production; the dev server proxies /api + /health
// to the running server on :8000. Workspace packages resolve to source for instant HMR.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  resolve: {
    alias: {
      "@ts-playwright/shared": path.resolve(here, "../../packages/shared/src/index.ts"),
      "@ts-playwright/ui": path.resolve(here, "../../packages/ui/src/index.ts")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000"
    }
  }
});
