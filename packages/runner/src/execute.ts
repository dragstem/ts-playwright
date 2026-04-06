import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_DOCKER_IMAGE, DEFAULT_PLAYWRIGHT_VERSION, queryNtpDrift, type RunStatus } from "@ts-playwright/shared";
import { prepareWorkspaceFromPackage, prepareWorkspaceFromSource, type PreparedWorkspace } from "./workspace";

export interface RunExecutionResult {
  status: RunStatus;
  artifacts_path: string;
  stdout_path: string;
  stderr_path: string;
  summary_json: string;
}

function playwrightCliPath(): string {
  return require.resolve("@playwright/test/cli");
}

function playwrightCommandArgs(args: string[]): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [playwrightCliPath(), ...args]
  };
}

function withNodeLikeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const nextEnv = { ...(env ?? process.env) };
  if (process.versions.electron) {
    nextEnv.ELECTRON_RUN_AS_NODE = "1";
  }
  return nextEnv;
}

export async function runScenarioInDocker(options: {
  scenario_zip: string;
  artifacts_dir: string;
  base_url: string;
  browser?: string;
  headless?: boolean;
  locale?: string;
  timezone?: string;
  viewport?: string;
  inputs?: Record<string, string>;
  otp_secrets?: Record<string, string>;
  docker_image?: string;
  otp_autoreplace?: boolean;
  timeout_ms?: number;
}): Promise<RunExecutionResult> {
  const prepared = prepareWorkspaceFromPackage({
    scenario_zip: options.scenario_zip,
    artifacts_dir: options.artifacts_dir,
    base_url: options.base_url,
    inputs: options.inputs,
    otp_secrets: options.otp_secrets,
    otp_autoreplace: options.otp_autoreplace
  });
  try {
    const drift = await queryNtpDrift();
    writeFileSync(path.join(options.artifacts_dir, "drift.log"), `local_vs_ntp=${drift ?? "unavailable"}\n`, "utf8");
    const exitCode = await spawnProcess(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${prepared.workspace_dir}:/work`,
        "-v",
        `${options.artifacts_dir}:/artifacts`,
        "-w",
        "/work",
        "-e",
        `ARTIFACTS_DIR=/artifacts`,
        "-e",
        `BASE_URL=${options.base_url}`,
        "-e",
        `PW_BROWSER=${options.browser ?? "chromium"}`,
        "-e",
        `PW_HEADLESS=${options.headless === false ? "false" : "true"}`,
        "-e",
        `PW_LOCALE=${options.locale ?? "ru-RU"}`,
        "-e",
        `PW_TIMEZONE=${options.timezone ?? "Europe/Riga"}`,
        "-e",
        `PW_VIEWPORT=${options.viewport ?? "1280x720"}`,
        "-e",
        `TOTP_CLOCK_DRIFT=${drift ?? 0}`,
        ...buildInputEnvArgs(options.inputs, options.otp_secrets),
        options.docker_image ?? DEFAULT_DOCKER_IMAGE,
        "npx",
        "-y",
        `@playwright/test@${DEFAULT_PLAYWRIGHT_VERSION}`,
        "test",
        "scenario.spec.ts",
        "--config=playwright.config.ts"
      ],
      options.artifacts_dir,
      { timeout_ms: options.timeout_ms }
    );
    return finalizeExecution(options.artifacts_dir, exitCode);
  } catch (error) {
    return finalizeExecution(options.artifacts_dir, null, error);
  } finally {
    prepared.cleanup();
  }
}

export async function replayScenarioLocally(options: {
  source_path: string;
  metadata: PreparedWorkspace["metadata"];
  artifacts_dir: string;
  base_url: string;
  auth_state_path?: string | null;
  otp_autoreplace?: boolean;
}): Promise<RunExecutionResult> {
  const prepared = prepareWorkspaceFromSource(options);
  try {
    const drift = await queryNtpDrift();
    writeFileSync(path.join(options.artifacts_dir, "drift.log"), `local_vs_ntp=${drift ?? "unavailable"}\n`, "utf8");
    const playwright = playwrightCommandArgs(["test", "scenario.spec.ts", "--config=playwright.config.ts"]);
    const exitCode = await spawnProcess(
      playwright.command,
      playwright.args,
      options.artifacts_dir,
      {
        cwd: prepared.workspace_dir,
        env: {
          ...withNodeLikeEnv(process.env),
          ARTIFACTS_DIR: options.artifacts_dir,
          BASE_URL: options.base_url,
          PW_BROWSER: options.metadata.browser,
          PW_HEADLESS: options.metadata.headless ? "true" : "false",
          PW_LOCALE: options.metadata.locale,
          PW_TIMEZONE: options.metadata.timezone,
          PW_VIEWPORT: `${options.metadata.viewport.width}x${options.metadata.viewport.height}`,
          TOTP_CLOCK_DRIFT: String(drift ?? 0)
        }
      }
    );
    return finalizeExecution(options.artifacts_dir, exitCode);
  } catch (error) {
    return finalizeExecution(options.artifacts_dir, null, error);
  } finally {
    prepared.cleanup();
  }
}

async function spawnProcess(
  command: string,
  args: string[],
  artifactsDir: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout_ms?: number;
  } = {}
): Promise<number> {
  mkdirSync(artifactsDir, { recursive: true });
  const stdoutPath = path.join(artifactsDir, "stdout.log");
  const stderrPath = path.join(artifactsDir, "stderr.log");
  const stdout = createWriteStream(stdoutPath, { encoding: "utf8" });
  const stderr = createWriteStream(stderrPath, { encoding: "utf8" });

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withNodeLikeEnv(options.env),
      shell: false
    });
    let didTimeout = false;
    const timeout =
      options.timeout_ms && options.timeout_ms > 0
        ? setTimeout(() => {
            didTimeout = true;
            child.kill();
          }, options.timeout_ms)
        : null;
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.once("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      stdout.end();
      stderr.end();
      reject(error);
    });
    child.once("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      stdout.end();
      stderr.end();
      if (didTimeout) {
        reject(new Error(`Process timed out after ${options.timeout_ms}ms`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function buildInputEnvArgs(inputs?: Record<string, string>, otpSecrets?: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(inputs ?? {})) {
    args.push("-e", `INPUT_${key}=${value}`);
  }
  for (const [key, value] of Object.entries(otpSecrets ?? {})) {
    args.push("-e", `TOTP_SECRET_${key}=${value}`);
  }
  return args;
}

function finalizeExecution(artifactsDir: string, exitCode: number | null, error?: unknown): RunExecutionResult {
  mkdirSync(artifactsDir, { recursive: true });
  const stdoutPath = path.join(artifactsDir, "stdout.log");
  const stderrPath = path.join(artifactsDir, "stderr.log");
  if (!existsSync(stdoutPath)) {
    writeFileSync(stdoutPath, "", "utf8");
  }
  if (!existsSync(stderrPath)) {
    writeFileSync(stderrPath, "", "utf8");
  }
  collectPlaywrightArtifacts(artifactsDir);
  mergeStdoutOutputs(artifactsDir);

  const status: RunStatus = error ? "error" : exitCode === 0 ? "passed" : "failed";
  const summary = {
    status,
    exit_code: exitCode,
    finished_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : error ? String(error) : undefined
  };
  writeFileSync(path.join(artifactsDir, "result.json"), JSON.stringify(summary, null, 2), "utf8");
  return {
    status,
    artifacts_path: artifactsDir,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    summary_json: JSON.stringify(summary)
  };
}

function collectPlaywrightArtifacts(artifactsDir: string): void {
  const outputDir = path.join(artifactsDir, "test-results");
  if (!existsSync(outputDir)) {
    return;
  }
  const files = walkFiles(outputDir);
  const trace = files.find((file) => file.endsWith("trace.zip"));
  if (trace && !existsSync(path.join(artifactsDir, "trace.zip"))) {
    copyFileSync(trace, path.join(artifactsDir, "trace.zip"));
  }

  const screenshot = files.find((file) => file.endsWith(".png"));
  if (screenshot && !existsSync(path.join(artifactsDir, "screenshot_on_fail.png"))) {
    copyFileSync(screenshot, path.join(artifactsDir, "screenshot_on_fail.png"));
  }

  const videos = files.filter((file) => file.endsWith(".webm"));
  if (videos.length > 0) {
    const videosDir = path.join(artifactsDir, "videos");
    mkdirSync(videosDir, { recursive: true });
    for (const video of videos) {
      copyFileSync(video, path.join(videosDir, path.basename(video)));
    }
  }
}

function mergeStdoutOutputs(artifactsDir: string): void {
  const stdoutPath = path.join(artifactsDir, "stdout.log");
  const outputsPath = path.join(artifactsDir, "outputs.json");
  const outputs = existsSync(outputsPath) ? JSON.parse(readFileSync(outputsPath, "utf8")) : {};
  const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("PW_OUTPUT")) {
      continue;
    }
    const payload = trimmed.slice("PW_OUTPUT".length).trim();
    if (!payload) {
      continue;
    }
    const [key, value = ""] = payload.includes("=") ? payload.split(/=(.*)/s, 2) : [payload, ""];
    if (!key) {
      continue;
    }
    outputs[key.trim()] = mergeValue(outputs[key.trim()], value.trim());
  }
  writeFileSync(outputsPath, JSON.stringify(outputs, null, 2), "utf8");
}

function mergeValue(existing: unknown, next: string): unknown {
  if (existing === undefined) {
    return next;
  }
  if (Array.isArray(existing)) {
    return [...existing, next];
  }
  return [existing, next];
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];
  for (const item of readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, item);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (stat.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
