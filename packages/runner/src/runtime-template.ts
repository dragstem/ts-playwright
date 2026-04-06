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

export function input(name) {
  const secret = process.env[\`TOTP_SECRET_\${name}\`];
  if (secret) {
    return liveTotp(secret);
  }
  const raw = process.env[\`INPUT_\${name}\`] ?? "";
  if (String(name ?? "").trim() === "2fa_otp" && raw) {
    return resolveTotpSecretFromFile(raw).then((fileSecret) => (fileSecret ? liveTotp(fileSecret) : raw));
  }
  return raw;
}

base.afterEach(async ({ page }, testInfo) => {
  await fs.mkdir(artifactsDir, { recursive: true });
  await captureOutputs(page);
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      await page.screenshot({ path: path.join(artifactsDir, "screenshot_on_fail.png"), fullPage: true });
    } catch {}
  }
});

export const test = base;
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
const viewportMatch = String(process.env.PW_VIEWPORT ?? "1280x720").match(/(\\d+)x(\\d+)/);
const viewport = viewportMatch
  ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) }
  : { width: 1280, height: 720 };

export default {
  testDir: process.cwd(),
  testMatch: ["scenario.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(artifactsDir, "playwright-report.json") }]
  ],
  outputDir: path.join(artifactsDir, "test-results"),
  use: {
    browserName,
    headless,
    baseURL: process.env.BASE_URL,
    locale: process.env.PW_LOCALE ?? "ru-RU",
    timezoneId: process.env.PW_TIMEZONE ?? "Europe/Riga",
    viewport,
    storageState: existsSync(authStatePath) ? authStatePath : undefined,
    trace: "on",
    video: "on",
    screenshot: "only-on-failure"
  }
};
`;
}
