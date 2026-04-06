import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

await Promise.all([
  rm(path.join(rootDir, "apps", "server", "dist"), { recursive: true, force: true }),
  rm(path.join(rootDir, "apps", "agent", "dist"), { recursive: true, force: true }),
  rm(path.join(rootDir, "packages", "shared", "dist"), { recursive: true, force: true }),
  rm(path.join(rootDir, "packages", "runner", "dist"), { recursive: true, force: true })
]);
