import path from "node:path";
import { ensureStorageLayout } from "@ts-playwright/shared";

export interface ServerConfig {
  root_dir: string;
  storage_dir: string;
  state_file: string;
  api_key: string | null;
  host: string;
  port: number;
  otp_autoreplace: boolean;
}

export function loadConfig(): ServerConfig {
  const rootDir = path.resolve(__dirname, "../../..");
  const storageDir = process.env.APP_STORAGE_DIR
    ? path.resolve(process.env.APP_STORAGE_DIR)
    : path.join(rootDir, "storage");
  ensureStorageLayout(storageDir);
  return {
    root_dir: rootDir,
    storage_dir: storageDir,
    state_file: path.join(storageDir, "app-state.json"),
    api_key: process.env.APP_API_KEY ?? null,
    host: process.env.APP_HOST ?? "0.0.0.0",
    port: Number(process.env.APP_PORT ?? 8000),
    otp_autoreplace: ["1", "true", "yes"].includes(String(process.env.APP_OTP_AUTOREPLACE ?? "").toLowerCase())
  };
}
