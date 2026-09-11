export function buildRuntimeModule(): string {
  return `import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import dgram from "node:dgram";
import { createHmac } from "node:crypto";

const requireFromPlaywright = createRequire(process.argv[1]);
const { test: base, expect } = requireFromPlaywright("@playwright/test");

const artifactsDir = process.env.ARTIFACTS_DIR ?? path.join(process.cwd(), "artifacts");
const metadataPath = path.join(process.cwd(), "metadata.json");
let cachedMetadata = null;
let cachedDrift = null;
let cachedTotpSecretsPath = null;
let cachedTotpSecrets = null;
const graphqlStates = new WeakMap();
const runtimeStartedAt = new Date();
const runtimeStartedHr = process.hrtime.bigint();
const runtimeInputValues = new Map();
let runtimeInputCounter = 0;

async function readMetadata() {
  if (cachedMetadata) {
    return cachedMetadata;
  }
  try {
    cachedMetadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch {
    cachedMetadata = { outputs: [] };
  }
  return cachedMetadata;
}

function mergeValue(existing, next) {
  if (existing === undefined) {
    return next;
  }
  if (Array.isArray(existing)) {
    return [...existing, next];
  }
  return [existing, next];
}

async function mergeOutputs(nextOutputs) {
  await fs.mkdir(artifactsDir, { recursive: true });
  const target = path.join(artifactsDir, "outputs.json");
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    current = {};
  }
  for (const [key, value] of Object.entries(nextOutputs)) {
    current[key] = mergeValue(current[key], value);
  }
  await fs.writeFile(target, JSON.stringify(current, null, 2), "utf8");
}

async function writeJsonArtifact(fileName, value) {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, fileName), JSON.stringify(value, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function extractGraphQLOperation(request) {
  try {
    const data = request.postDataJSON();
    if (Array.isArray(data)) {
      return data.map((item) => item?.operationName).filter(Boolean).join(",") || "";
    }
    return String(data?.operationName ?? "");
  } catch {
    return "";
  }
}

function isGraphQLRequest(request) {
  const url = request.url();
  if (/\\/graphql(?:\\?|$|\\/)/i.test(url)) {
    return true;
  }
  try {
    const contentType = String(request.headers()["content-type"] ?? "");
    const body = request.postData() ?? "";
    return contentType.includes("json") && /"operationName"\\s*:/.test(body);
  } catch {
    return false;
  }
}

function ensureGraphQLMonitor(page) {
  const existing = graphqlStates.get(page);
  if (existing) {
    return existing;
  }

  const state = {
    active: new Map(),
    events: []
  };
  graphqlStates.set(page, state);

  page.on("request", (request) => {
    if (!isGraphQLRequest(request)) {
      return;
    }
    const item = {
      url: request.url(),
      method: request.method(),
      operationName: extractGraphQLOperation(request),
      started_at: nowIso(),
      finished_at: null,
      status: null,
      ok: null,
      errors: []
    };
    state.active.set(request, item);
    state.events.push(item);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const item = state.active.get(request);
    if (!item) {
      return;
    }
    item.status = response.status();
    item.ok = response.ok();
    try {
      const contentType = String(response.headers()["content-type"] ?? "");
      if (contentType.includes("json")) {
        const body = await response.json();
        const errors = Array.isArray(body?.errors) ? body.errors : [];
        item.errors = errors.map((error) => String(error?.message ?? error)).filter(Boolean);
      }
    } catch {
      // GraphQL response bodies are diagnostic only; consuming failures should not affect the scenario.
    }
  });

  const finish = (request) => {
    const item = state.active.get(request);
    if (!item) {
      return;
    }
    item.finished_at = nowIso();
    state.active.delete(request);
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);

  return state;
}

export async function waitForGraphQLIdle(page, options = {}) {
  const timeoutMs = Number(options.timeout_ms ?? process.env.PW_GRAPHQL_IDLE_TIMEOUT_MS ?? 5000);
  const quietMs = Number(options.quiet_ms ?? process.env.PW_GRAPHQL_IDLE_QUIET_MS ?? 350);
  const state = ensureGraphQLMonitor(page);
  const startedAt = Date.now();
  let idleSince = state.active.size === 0 ? Date.now() : 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (state.active.size === 0) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince >= quietMs) {
        return;
      }
    } else {
      idleSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function selectComboboxOption(page, optionName, options = {}) {
  ensureGraphQLMonitor(page);
  const resolvedOptionName = await optionName;
  const configuredDefaultTimeout = Number(process.env.PW_DEFAULT_TIMEOUT_MS ?? "");
  const timeoutMs = Number(
    options.timeout_ms ??
      (Number.isFinite(configuredDefaultTimeout) && configuredDefaultTimeout > 0 ? configuredDefaultTimeout : 10000)
  );
  const probeTimeoutMs = Number(options.probe_timeout_ms ?? Math.min(timeoutMs, 2500));
  const exact = options.exact !== false;
  const comboboxes = options.locator ?? page.getByRole("combobox");
  const option = () => page.getByRole("option", { name: resolvedOptionName, exact }).first();
  let count = 0;
  let lastError = null;

  try {
    await comboboxes.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    lastError = error;
  }

  try {
    count = await comboboxes.count();
  } catch (error) {
    lastError = error;
  }

  for (let index = 0; index < count; index += 1) {
    const combobox = comboboxes.nth(index);
    try {
      const visible = await combobox.isVisible({ timeout: Math.min(probeTimeoutMs, 1000) }).catch(() => false);
      const enabled = await combobox.isEnabled({ timeout: Math.min(probeTimeoutMs, 1000) }).catch(() => false);
      if (!visible || !enabled) {
        continue;
      }
      await combobox.scrollIntoViewIfNeeded({ timeout: probeTimeoutMs }).catch(() => {});
      const openAttempts = [
        async () => {
          await combobox.click({ timeout: timeoutMs });
        },
        async () => {
          await combobox.evaluate((element) => {
            element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            element.click();
          });
        },
        async () => {
          await combobox.click({ timeout: timeoutMs, force: true });
        }
      ];

      for (const open of openAttempts) {
        try {
          await open();
          const candidate = option();
          await candidate.waitFor({ state: "visible", timeout: probeTimeoutMs });
          try {
            await candidate.click({ timeout: timeoutMs });
          } catch {
            await candidate.evaluate((element) => element.click());
          }
          await waitForGraphQLIdle(page).catch(() => {});
          return;
        } catch (error) {
          lastError = error;
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
      await waitForGraphQLIdle(page).catch(() => {});
    } catch (error) {
      lastError = error;
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  const suffix = lastError instanceof Error ? " Last error: " + lastError.message : "";
  throw new Error(
    'Unable to select option "' + String(resolvedOptionName) + '" from any visible combobox. Found ' + count + " combobox locator(s)." + suffix
  );
}

function padNumber(value, length) {
  return String(value).padStart(length, "0");
}

function runtimeDatetimeSuffix() {
  runtimeInputCounter += 1;
  const stamp =
    String(runtimeStartedAt.getFullYear()) +
    padNumber(runtimeStartedAt.getMonth() + 1, 2) +
    padNumber(runtimeStartedAt.getDate(), 2) +
    padNumber(runtimeStartedAt.getHours(), 2) +
    padNumber(runtimeStartedAt.getMinutes(), 2) +
    padNumber(runtimeStartedAt.getSeconds(), 2) +
    padNumber(runtimeStartedAt.getMilliseconds(), 3);
  const highResolutionPart = padNumber(Number(runtimeStartedHr % 1000000n), 6);
  return stamp + highResolutionPart + padNumber(runtimeInputCounter, 6);
}

function resolveRuntimeInputPresets(name, value) {
  const key = String(name ?? "");
  const raw = String(value ?? "");
  if (!raw.includes("{datetime}")) {
    return raw;
  }
  if (runtimeInputValues.has(key)) {
    return runtimeInputValues.get(key);
  }
  const resolved = raw.replaceAll("{datetime}", runtimeDatetimeSuffix());
  runtimeInputValues.set(key, resolved);
  return resolved;
}

export async function waitForAppReady(page, options = {}) {
  ensureGraphQLMonitor(page);
  const timeoutMs = Number(options.timeout_ms ?? process.env.PW_APP_READY_TIMEOUT_MS ?? 15000);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  } catch {}
  try {
    await page.waitForFunction(
      () => document.readyState === "interactive" || document.readyState === "complete",
      null,
      { timeout: timeoutMs }
    );
  } catch {}
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#__next") || document.querySelector("#root") || document.body;
        return Boolean(document.body && document.body.children.length > 0 && root);
      },
      null,
      { timeout: timeoutMs }
    );
  } catch {}
  await waitForGraphQLIdle(page, {
    timeout_ms: Number(options.graphql_timeout_ms ?? process.env.PW_GRAPHQL_IDLE_TIMEOUT_MS ?? 5000)
  });
}

function isPassInputValue(value) {
  return String(value ?? "").trim().toUpperCase() === "PASS";
}

export async function fillIfNotPass(target, value, options = undefined) {
  const resolvedValue = await value;
  if (isPassInputValue(resolvedValue)) {
    return;
  }
  if (options === undefined) {
    await target.fill(resolvedValue);
    return;
  }
  await target.fill(resolvedValue, options);
}

async function captureOutputs(page) {
  const metadata = await readMetadata();
  const specs = Array.isArray(metadata.outputs) ? metadata.outputs : [];
  if (specs.length === 0) {
    return;
  }

  const outputs = {};
  for (const spec of specs) {
    const key = String(spec.key ?? "").trim();
    const selector = String(spec.selector ?? "").trim();
    if (!key || !selector) {
      continue;
    }
    const mode = String(spec.mode ?? "text").trim().toLowerCase();
    const attr = String(spec.attr ?? "").trim();
    const frame = String(spec.frame ?? "").trim();
    let timeoutMs = Number(spec.timeout_ms ?? 2000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = 2000;
    }
    try {
      const locator = frame ? page.frameLocator(frame).locator(selector).first() : page.locator(selector).first();
      let value = "";
      if (mode === "value" || mode === "input") {
        value = await locator.inputValue({ timeout: timeoutMs });
      } else if (mode.startsWith("attr")) {
        const attrName = attr || mode.split(":")[1]?.trim() || "";
        value = attrName ? (await locator.getAttribute(attrName, { timeout: timeoutMs })) ?? "" : "ERROR: Missing attr";
      } else {
        value = await locator.innerText({ timeout: timeoutMs });
      }
      outputs[key] = mergeValue(outputs[key], value);
    } catch (error) {
      outputs[key] = mergeValue(outputs[key], \`ERROR: \${error instanceof Error ? error.name : "UnknownError"}\`);
    }
  }
  await mergeOutputs(outputs);
}

async function queryNtpDrift(timeoutMs = 3000) {
  return await new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      resolve(null);
    }, timeoutMs);

    socket.once("error", () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(null);
    });

    socket.once("message", (message) => {
      clearTimeout(timer);
      try {
        const seconds = message.readUInt32BE(40) - 2208988800;
        const fraction = message.readUInt32BE(44) / 2 ** 32;
        const ntpTime = seconds + fraction;
        const finishedAt = Date.now();
        const localMid = (startedAt + finishedAt) / 2000;
        socket.close();
        resolve(localMid - ntpTime);
      } catch {
        try {
          socket.close();
        } catch {}
        resolve(null);
      }
    });

    socket.send(packet, 123, "pool.ntp.org", (error) => {
      if (error) {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        resolve(null);
      }
    });
  });
}

function parseTotpSecretsDocument(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return {};
  }
  if (source.startsWith("{")) {
    const parsed = JSON.parse(source);
    const result = {};
    for (const [login, value] of Object.entries(parsed ?? {})) {
      const normalizedLogin = String(login ?? "").trim();
      if (!normalizedLogin) {
        continue;
      }
      const secret = typeof value === "string" ? value.trim() : typeof value?.secret === "string" ? value.secret.trim() : "";
      if (!secret) {
        continue;
      }
      result[normalizedLogin] = secret;
    }
    return result;
  }
  const result = {};
  for (const rawLine of source.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const separatorIndex = line.includes("=") ? line.indexOf("=") : line.indexOf(":");
    if (separatorIndex < 0) {
      throw new Error("Invalid TOTP secrets line: " + line);
    }
    const login = line.slice(0, separatorIndex).trim();
    const secret = line.slice(separatorIndex + 1).trim();
    if (!login || !secret) {
      throw new Error("Invalid TOTP secrets line: " + line);
    }
    result[login] = secret;
  }
  return result;
}

async function readTotpSecretsFile() {
  const filePath = String(process.env.TOTP_SECRETS_FILE ?? "").trim();
  if (!filePath) {
    return {};
  }
  if (cachedTotpSecrets && cachedTotpSecretsPath === filePath) {
    return cachedTotpSecrets;
  }
  const text = await fs.readFile(filePath, "utf8");
  cachedTotpSecrets = parseTotpSecretsDocument(text);
  cachedTotpSecretsPath = filePath;
  return cachedTotpSecrets;
}

async function resolveTotpSecretFromFile(login) {
  const normalizedLogin = String(login ?? "").trim();
  if (!normalizedLogin) {
    return "";
  }
  try {
    const secrets = await readTotpSecretsFile();
    return String(secrets[normalizedLogin] ?? "").trim();
  } catch {
    return "";
  }
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=/g, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid base32");
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secret, forTime, digits = 6, period = 30) {
  const normalized = String(secret ?? "").replace(/\\s+/g, "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  const key = decodeBase32(normalized);
  const counter = Math.floor(forTime / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

async function liveTotp(secret) {
  if (!secret) {
    return "";
  }
  if (cachedDrift === null) {
    const envDrift = Number(process.env.TOTP_CLOCK_DRIFT ?? "0");
    cachedDrift = (await queryNtpDrift()) ?? envDrift;
  }
  for (let index = 0; index < 35; index += 1) {
    const corrected = Date.now() / 1000 - cachedDrift;
    const remaining = 30 - (corrected % 30);
    if (remaining >= 20) {
      return totp(secret, corrected);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const corrected = Date.now() / 1000 - cachedDrift;
  return totp(secret, corrected);
}

function tryNormalizeTotpSecret(value) {
  const normalized = String(value ?? "").replace(/\\s+/g, "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  try {
    decodeBase32(normalized);
    return normalized;
  } catch {
    return "";
  }
}

export function input(name) {
  const normalizedName = String(name ?? "").trim();
  // Ignore-variables mode: insert nothing. IGNORE_VARIABLES=1 skips every token; IGNORE_INPUTS is a
  // comma-separated list of individual input names to skip. Sits above the server-token throw below, so
  // a skipped {server_*} runs with an empty value instead of failing.
  if (
    process.env.IGNORE_VARIABLES === "1" ||
    (process.env.IGNORE_INPUTS ? process.env.IGNORE_INPUTS.split(",").indexOf(normalizedName) !== -1 : false)
  ) {
    return "";
  }
  const secret = process.env[\`TOTP_SECRET_\${name}\`];
  if (secret) {
    return liveTotp(secret);
  }
  const raw = resolveRuntimeInputPresets(normalizedName, process.env[\`INPUT_\${name}\`] ?? "");
  if ((normalizedName === "2fa_otp" || normalizedName === "server_2faotp") && raw) {
    const inlineSecret = tryNormalizeTotpSecret(raw);
    if (inlineSecret) {
      return liveTotp(inlineSecret);
    }
    return resolveTotpSecretFromFile(raw).then((fileSecret) => (fileSecret ? liveTotp(fileSecret) : raw));
  }
  if (["server_username", "server_password", "server_2faotp", "server_merchant"].includes(normalizedName) && !raw) {
    throw new Error("Missing server input: " + normalizedName + ". Select a server account or merchant before running.");
  }
  return raw;
}

const test = base.extend({
  page: async ({ page }, use) => {
    ensureGraphQLMonitor(page);
    await use(page);
  }
});

test.afterEach(async ({ page }, testInfo) => {
  await fs.mkdir(artifactsDir, { recursive: true });
  const graphqlState = graphqlStates.get(page);
  await writeJsonArtifact("graphql-report.json", graphqlState?.events ?? []);
  await captureOutputs(page);
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      await page.screenshot({ path: path.join(artifactsDir, "screenshot_on_fail.png"), fullPage: true });
    } catch {}
  }
});

export { test };
export { expect };
`;
}

export function buildPlaywrightConfigModule(): string {
  return `import path from "node:path";
import { existsSync } from "node:fs";

const artifactsDir = process.env.ARTIFACTS_DIR ?? path.join(process.cwd(), "artifacts");
const authStatePath = path.join(process.cwd(), "auth_state.json");
const browserName = process.env.PW_BROWSER ?? "chromium";
const headless = (process.env.PW_HEADLESS ?? "true").toLowerCase() !== "false";
const configuredDefaultTimeout = Number(process.env.PW_DEFAULT_TIMEOUT_MS ?? "");
const defaultTimeout =
  Number.isFinite(configuredDefaultTimeout) && configuredDefaultTimeout > 0
    ? Math.trunc(configuredDefaultTimeout)
    : undefined;
const viewportMatch = String(process.env.PW_VIEWPORT ?? "1280x720").match(/(\\d+)x(\\d+)/);
const viewport = viewportMatch
  ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) }
  : { width: 1280, height: 720 };

export default {
  testDir: process.cwd(),
  testMatch: ["scenario.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: defaultTimeout,
  expect: defaultTimeout ? { timeout: defaultTimeout } : undefined,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(artifactsDir, "playwright-report.json") }]
  ],
  outputDir: path.join(artifactsDir, "test-results"),
  use: {
    browserName,
    headless,
    baseURL: process.env.BASE_URL,
    testIdAttribute: "id",
    locale: process.env.PW_LOCALE ?? "ru-RU",
    timezoneId: process.env.PW_TIMEZONE ?? "Europe/Riga",
    viewport,
    actionTimeout: defaultTimeout,
    navigationTimeout: defaultTimeout,
    storageState: existsSync(authStatePath) ? authStatePath : undefined,
    trace: "on",
    video: "on",
    screenshot: "only-on-failure"
  }
};
`;
}
