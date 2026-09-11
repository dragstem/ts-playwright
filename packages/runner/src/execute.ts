import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_PLAYWRIGHT_VERSION,
  SCENARIO_FILE_NAME,
  queryNtpDrift,
  type RunLogEntry,
  type RunPhase,
  type RunStatus
} from "@ts-playwright/shared";
import { detectRequiredServerInputs } from "./process-source";
import { prepareWorkspaceFromPackage, prepareWorkspaceFromSource, type PreparedWorkspace } from "./workspace";

export interface RunExecutionResult {
  status: RunStatus;
  artifacts_path: string;
  stdout_path: string;
  stderr_path: string;
  summary_json: string;
}

export type RunExecutionLogEvent = RunLogEntry;

export type DockerWorkspaceTransport = "auto" | "bind" | "copy";
export type DockerRunnerMode = "npx" | "global";

const DEFAULT_DOCKER_SHM_SIZE = "1g";

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
  docker_shm_size?: string | null;
  docker_ipc?: string | null;
  docker_network?: string | null;
  docker_add_hosts?: string[];
  docker_cpus?: string | null;
  docker_memory?: string | null;
  docker_pids_limit?: number | null;
  docker_cap_drop?: string | null;
  docker_no_new_privileges?: boolean;
  docker_workspace_transport?: DockerWorkspaceTransport;
  docker_runner_mode?: DockerRunnerMode;
  // Deterministic container name so the server can `docker kill` this run on Stop. When omitted,
  // bind mode runs anonymously and copy mode generates a random name (unchanged legacy behaviour).
  container_name?: string;
  otp_autoreplace?: boolean;
  // When true the run inserts nothing for any input variable (input() returns "" in the container).
  // Skips the required-input preflight since those values are intentionally absent.
  ignore_variables?: boolean;
  // Individual input names to skip (insert nothing) — the per-variable form of ignore_variables.
  ignored_inputs?: string[];
  timeout_ms?: number;
  default_timeout_ms?: number;
  on_log?: (entry: RunExecutionLogEvent) => void;
  on_phase?: (phase: RunPhase) => void;
}): Promise<RunExecutionResult> {
  const onPhase = options.on_phase;
  const prepared = prepareWorkspaceFromPackage({
    scenario_zip: options.scenario_zip,
    artifacts_dir: options.artifacts_dir,
    base_url: options.base_url,
    inputs: options.inputs,
    otp_secrets: options.otp_secrets,
    otp_autoreplace: options.otp_autoreplace
  });
  try {
    onPhase?.("prepare");
    emitRunLog(options.on_log, "Preparing isolated workspace for Docker execution.");
    writeCodegenDiagnostics(options.artifacts_dir, prepared.diagnostics, options.on_log);
    if (options.ignore_variables) {
      emitRunLog(options.on_log, "Ignore-variables mode: no input values will be inserted for this run.", "warning");
    } else {
      preflightRuntimeInputs(prepared, options.inputs, options.otp_secrets);
    }
    const drift = await queryNtpDrift();
    writeFileSync(path.join(options.artifacts_dir, "drift.log"), `local_vs_ntp=${drift ?? "unavailable"}\n`, "utf8");
    emitRunLog(
      options.on_log,
      drift === null
        ? "NTP drift check is unavailable. Continuing with local clock."
        : `Calculated local clock drift against NTP: ${drift} seconds.`
    );
    onPhase?.("pull_image");
    await ensureDockerReady({
      artifacts_dir: options.artifacts_dir,
      docker_image: options.docker_image ?? DEFAULT_DOCKER_IMAGE,
      timeout_ms: options.timeout_ms,
      on_log: options.on_log
    });
    onPhase?.("create_container");
    emitRunLog(options.on_log, "Starting Playwright container.");
    const dockerOptions = {
      image: options.docker_image ?? DEFAULT_DOCKER_IMAGE,
      shm_size: options.docker_shm_size === undefined ? DEFAULT_DOCKER_SHM_SIZE : options.docker_shm_size,
      ipc: options.docker_ipc,
      network: options.docker_network,
      add_hosts: options.docker_add_hosts ?? [],
      cpus: options.docker_cpus ?? null,
      memory: options.docker_memory ?? null,
      pids_limit: options.docker_pids_limit ?? null,
      cap_drop: options.docker_cap_drop ?? null,
      no_new_privileges: options.docker_no_new_privileges ?? false,
      workspace_transport: normalizeWorkspaceTransport(options.docker_workspace_transport),
      runner_mode: options.docker_runner_mode ?? "npx",
      container_name: options.container_name,
      env_args: buildRuntimeEnvArgs({
        base_url: options.base_url,
        browser: options.browser,
        headless: options.headless,
        locale: options.locale,
        timezone: options.timezone,
        viewport: options.viewport,
        default_timeout_ms: options.default_timeout_ms,
        drift,
        inputs: options.inputs,
        otp_secrets: options.otp_secrets,
        ignore_variables: options.ignore_variables,
        ignored_inputs: options.ignored_inputs
      })
    };
    const exitCode =
      dockerOptions.workspace_transport === "copy"
        ? await runCopiedWorkspaceContainer(prepared, options.artifacts_dir, dockerOptions, options.timeout_ms, onPhase)
        : await runBindMountedWorkspaceContainer(prepared, options.artifacts_dir, dockerOptions, options.timeout_ms, onPhase);
    emitRunLog(
      options.on_log,
      exitCode === 0
        ? "Playwright container finished successfully."
        : `Playwright container finished with exit code ${exitCode}.`,
      exitCode === 0 ? "info" : "warning"
    );
    onPhase?.("collecting");
    return finalizeExecution(options.artifacts_dir, exitCode);
  } catch (error) {
    emitRunLog(options.on_log, formatExecutionError(error), "error");
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
  default_timeout_ms?: number;
}): Promise<RunExecutionResult> {
  const prepared = prepareWorkspaceFromSource(options);
  try {
    writeCodegenDiagnostics(options.artifacts_dir, prepared.diagnostics);
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
          PW_DEFAULT_TIMEOUT_MS: String(options.default_timeout_ms ?? ""),
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

function writeCodegenDiagnostics(
  artifactsDir: string,
  diagnostics: PreparedWorkspace["diagnostics"],
  onLog?: (entry: RunExecutionLogEvent) => void
): void {
  mkdirSync(artifactsDir, { recursive: true });
  const targetPath = path.join(artifactsDir, "codegen-diagnostics.json");
  writeFileSync(targetPath, JSON.stringify(diagnostics, null, 2), "utf8");
  if (diagnostics.length === 0) {
    return;
  }
  emitRunLog(onLog, `Codegen diagnostics recorded ${diagnostics.length} advisory finding(s).`, "warning");
  for (const diagnostic of diagnostics.slice(0, 5)) {
    emitRunLog(onLog, `${diagnostic.code} at line ${diagnostic.line}: ${diagnostic.message}`, diagnostic.severity);
  }
}

function preflightRuntimeInputs(
  prepared: PreparedWorkspace,
  inputs?: Record<string, string>,
  otpSecrets?: Record<string, string>
): void {
  const source = readFileSync(path.join(prepared.workspace_dir, SCENARIO_FILE_NAME), "utf8");
  const requiredServerInputs = detectRequiredServerInputs(source);
  const missing = requiredServerInputs.filter((name) => !hasServerInput(name, inputs, otpSecrets));
  if (missing.length > 0) {
    throw new Error(`Missing required server runtime input(s): ${missing.join(", ")}`);
  }
}

function hasServerInput(name: string, inputs?: Record<string, string>, otpSecrets?: Record<string, string>): boolean {
  const inputValue = String(inputs?.[name] ?? "").trim();
  if (inputValue) {
    return true;
  }
  if (name === "server_2faotp") {
    return Boolean(String(otpSecrets?.[name] ?? "").trim());
  }
  return false;
}

function buildRuntimeEnvArgs(options: {
  base_url: string;
  browser?: string;
  headless?: boolean;
  locale?: string;
  timezone?: string;
  viewport?: string;
  default_timeout_ms?: number;
  drift: number | null;
  inputs?: Record<string, string>;
  otp_secrets?: Record<string, string>;
  ignore_variables?: boolean;
  ignored_inputs?: string[];
}): string[] {
  return [
    "-e",
    "ARTIFACTS_DIR=/artifacts",
    ...(options.ignore_variables ? ["-e", "IGNORE_VARIABLES=1"] : []),
    ...(options.ignored_inputs && options.ignored_inputs.length > 0
      ? ["-e", `IGNORE_INPUTS=${options.ignored_inputs.join(",")}`]
      : []),
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
    `PW_DEFAULT_TIMEOUT_MS=${String(options.default_timeout_ms ?? "")}`,
    "-e",
    `TOTP_CLOCK_DRIFT=${options.drift ?? 0}`,
    ...buildInputEnvArgs(options.inputs, options.otp_secrets)
  ];
}

export interface DockerRuntimeArgsOptions {
  shm_size?: string | null;
  ipc?: string | null;
  network?: string | null;
  add_hosts?: string[];
  cpus?: string | null;
  memory?: string | null;
  pids_limit?: number | null;
  cap_drop?: string | null;
  no_new_privileges?: boolean;
}

// Build the hardening/limit flags for a runner container. Every flag is optional and
// driven by server config so a deployment can tune or disable it without code changes.
// NOTE: `no-new-privileges` is intentionally NOT forced on by default — it blocks setuid
// escalation, which breaks Chromium's setuid sandbox (chrome-sandbox) in the Microsoft
// Playwright image. Enable APP_DOCKER_NO_NEW_PRIVILEGES only together with a verified
// `--no-sandbox` Chromium launch. `--read-only` is deliberately not used: the runner writes
// to /work and /artifacts.
export function buildDockerRuntimeArgs(options: DockerRuntimeArgsOptions): string[] {
  const args: string[] = [];
  if (options.cap_drop) {
    args.push("--cap-drop", options.cap_drop);
  }
  if (options.no_new_privileges) {
    args.push("--security-opt", "no-new-privileges");
  }
  if (options.shm_size) {
    args.push("--shm-size", options.shm_size);
  }
  if (options.cpus) {
    args.push("--cpus", options.cpus);
  }
  if (options.memory) {
    // Pin memory-swap to the same value so the memory cap cannot be bypassed via swap.
    args.push("--memory", options.memory, "--memory-swap", options.memory);
  }
  if (typeof options.pids_limit === "number" && options.pids_limit > 0) {
    args.push("--pids-limit", String(options.pids_limit));
  }
  if (options.ipc) {
    args.push("--ipc", options.ipc);
  }
  if (options.network) {
    args.push("--network", options.network);
  }
  for (const host of options.add_hosts ?? []) {
    if (host) {
      args.push("--add-host", host);
    }
  }
  return args;
}

function buildPlaywrightDockerCommand(mode: DockerRunnerMode): string[] {
  if (mode === "global") {
    return ["playwright", "test", "scenario.spec.ts", "--config=playwright.config.ts"];
  }
  return ["npx", "-y", `@playwright/test@${DEFAULT_PLAYWRIGHT_VERSION}`, "test", "scenario.spec.ts", "--config=playwright.config.ts"];
}

async function runBindMountedWorkspaceContainer(
  prepared: PreparedWorkspace,
  artifactsDir: string,
  options: {
    image: string;
    shm_size?: string | null;
    ipc?: string | null;
    network?: string | null;
    add_hosts?: string[];
    cpus?: string | null;
    memory?: string | null;
    pids_limit?: number | null;
    cap_drop?: string | null;
    no_new_privileges?: boolean;
    runner_mode: DockerRunnerMode;
    container_name?: string;
    env_args: string[];
  },
  timeoutMs?: number,
  onPhase?: (phase: RunPhase) => void
): Promise<number> {
  onPhase?.("execute");
  return await spawnProcess(
    "docker",
    [
      "run",
      "--rm",
      ...(options.container_name ? ["--name", options.container_name] : []),
      ...buildDockerRuntimeArgs(options),
      "-v",
      `${prepared.workspace_dir}:/work`,
      "-v",
      `${artifactsDir}:/artifacts`,
      "-w",
      "/work",
      ...options.env_args,
      options.image,
      ...buildPlaywrightDockerCommand(options.runner_mode)
    ],
    artifactsDir,
    { timeout_ms: timeoutMs }
  );
}

async function runCopiedWorkspaceContainer(
  prepared: PreparedWorkspace,
  artifactsDir: string,
  options: {
    image: string;
    shm_size?: string | null;
    ipc?: string | null;
    network?: string | null;
    add_hosts?: string[];
    cpus?: string | null;
    memory?: string | null;
    pids_limit?: number | null;
    cap_drop?: string | null;
    no_new_privileges?: boolean;
    runner_mode: DockerRunnerMode;
    container_name?: string;
    env_args: string[];
  },
  timeoutMs?: number,
  onPhase?: (phase: RunPhase) => void
): Promise<number> {
  const containerName = options.container_name ?? `ts-playwright-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const create = await spawnProcessCapture("docker", [
    "create",
    "--name",
    containerName,
    ...buildDockerRuntimeArgs(options),
    "-w",
    "/work",
    ...options.env_args,
    options.image,
    ...buildPlaywrightDockerCommand(options.runner_mode)
  ]);
  if (create.code !== 0) {
    throw new Error(`Docker failed to create runner container: ${collapseWhitespace(create.stderr || create.stdout)}`);
  }

  try {
    const copyIn = await spawnProcessCapture("docker", ["cp", `${prepared.workspace_dir}${path.sep}.`, `${containerName}:/work`]);
    if (copyIn.code !== 0) {
      throw new Error(`Docker failed to copy workspace into runner container: ${collapseWhitespace(copyIn.stderr || copyIn.stdout)}`);
    }

    onPhase?.("execute");
    const exitCode = await spawnProcess("docker", ["start", "-a", containerName], artifactsDir, { timeout_ms: timeoutMs });
    const copyOut = await spawnProcessCapture("docker", ["cp", `${containerName}:/artifacts/.`, artifactsDir]);
    if (copyOut.code !== 0 && exitCode === 0) {
      throw new Error(`Docker failed to copy artifacts out of runner container: ${collapseWhitespace(copyOut.stderr || copyOut.stdout)}`);
    }
    return exitCode;
  } finally {
    await spawnProcessCapture("docker", ["rm", "-f", containerName]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  }
}

function normalizeWorkspaceTransport(value: DockerWorkspaceTransport | undefined): "bind" | "copy" {
  const configured = value ?? "auto";
  if (configured === "bind" || configured === "copy") {
    return configured;
  }
  return isRunningInContainer() ? "copy" : "bind";
}

function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv");
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
  const stdout = createWriteStream(stdoutPath, { encoding: "utf8", flags: "a" });
  const stderr = createWriteStream(stderrPath, { encoding: "utf8", flags: "a" });

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

async function ensureDockerReady(options: {
  artifacts_dir: string;
  docker_image: string;
  timeout_ms?: number;
  on_log?: (entry: RunExecutionLogEvent) => void;
}): Promise<void> {
  emitRunLog(options.on_log, "Checking Docker CLI and daemon availability.");
  const version = await spawnProcessCapture("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout_ms: Math.min(options.timeout_ms ?? 30_000, 30_000)
  }).catch((error) => {
    throw toDockerLaunchError(error);
  });

  if (version.code !== 0) {
    throw new Error(formatDockerUnavailableMessage(version.stderr || version.stdout));
  }

  const serverVersion = version.stdout.trim();
  emitRunLog(
    options.on_log,
    serverVersion ? `Docker daemon is ready (server ${serverVersion}).` : "Docker daemon is ready."
  );

  emitRunLog(options.on_log, `Checking whether Docker image ${options.docker_image} is already cached locally.`);
  const inspect = await spawnProcessCapture("docker", ["image", "inspect", options.docker_image], {
    timeout_ms: Math.min(options.timeout_ms ?? 30_000, 30_000)
  }).catch((error) => {
    throw toDockerLaunchError(error);
  });

  if (inspect.code === 0) {
    emitRunLog(options.on_log, `Docker image ${options.docker_image} is already available locally.`);
    return;
  }

  emitRunLog(
    options.on_log,
    `Docker image ${options.docker_image} is not cached locally. On a clean PC the first run can take a few minutes while Docker pulls the Playwright image.`,
    "warning"
  );
  emitRunLog(options.on_log, `Pulling Docker image ${options.docker_image}. Progress will appear in stdout/stderr below.`);
  const pullExitCode = await spawnProcess("docker", ["pull", options.docker_image], options.artifacts_dir, {
    timeout_ms: options.timeout_ms
  }).catch((error) => {
    throw toDockerLaunchError(error);
  });

  if (pullExitCode !== 0) {
    throw new Error(
      `Docker failed to pull image ${options.docker_image}. Check Docker Desktop, registry access, and network connectivity.`
    );
  }

  emitRunLog(options.on_log, `Docker image ${options.docker_image} is ready.`);
}

async function spawnProcessCapture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout_ms?: number;
  } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withNodeLikeEnv(options.env),
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let didTimeout = false;
    const timeout =
      options.timeout_ms && options.timeout_ms > 0
        ? setTimeout(() => {
            didTimeout = true;
            child.kill();
          }, options.timeout_ms)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.once("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (didTimeout) {
        reject(new Error(`Process timed out after ${options.timeout_ms}ms`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
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

function emitRunLog(
  onLog: ((entry: RunExecutionLogEvent) => void) | undefined,
  message: string,
  level: RunExecutionLogEvent["level"] = "info"
): void {
  onLog?.({
    timestamp: new Date().toISOString(),
    level,
    message
  });
}

function toDockerLaunchError(error: unknown): Error {
  if (isNodeErrorWithCode(error) && error.code === "ENOENT") {
    return new Error("Docker CLI was not found. Install Docker Desktop and make sure the `docker` command is available.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function formatDockerUnavailableMessage(rawOutput: string): string {
  const output = rawOutput.trim();
  if (/error during connect|cannot connect|docker daemon|docker_engine|is the docker daemon running/i.test(output)) {
    return "Docker daemon is unavailable. Start Docker Desktop, wait until it shows that the engine is running, and retry.";
  }
  return output
    ? `Docker is not ready: ${collapseWhitespace(output)}`
    : "Docker is not ready. Start Docker Desktop and retry.";
}

function formatExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Docker run failed: ${collapseWhitespace(message)}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}
