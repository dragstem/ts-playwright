import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "apps", "agent", "assets");
const targetDir = path.join(rootDir, "apps", "agent", "dist", "assets");

await mkdir(targetDir, { recursive: true });
await copyFile(path.join(sourceDir, "index.html"), path.join(targetDir, "index.html"));
await copyFile(path.join(sourceDir, "styles.css"), path.join(targetDir, "styles.css"));
await copyFile(path.join(sourceDir, "renderer.js"), path.join(targetDir, "renderer.js"));
await copyFile(path.join(sourceDir, "config.example.json"), path.join(targetDir, "config.example.json"));
