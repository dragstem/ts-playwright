import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const agentDir = path.join(rootDir, "apps", "agent");
const entryPath = path.join(agentDir, "dist", "main.js");
const requireFromAgent = createRequire(path.join(agentDir, "package.json"));
const electron = requireFromAgent("electron");

if (!existsSync(entryPath)) {
  console.error("Agent build output is missing at apps/agent/dist/main.js.");
  console.error("Run `corepack pnpm run build` or `corepack pnpm run start:agent` again after fixing the build.");
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [entryPath], {
  cwd: agentDir,
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("Failed to launch Electron:", error);
  process.exit(1);
});
