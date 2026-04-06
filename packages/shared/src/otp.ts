import { createHmac } from "node:crypto";
import dgram from "node:dgram";
import { readFile } from "node:fs/promises";

const DEFAULT_TOTP_DIGITS = 6;
const DEFAULT_TOTP_PERIOD = 30;
const DEFAULT_TOTP_MIN_REMAINING = 20;

export function normalizeTotpSecret(secret: string): string {
  const value = String(secret ?? "").replaceAll(" ", "").trim().toUpperCase();
  if (!value) {
    throw new Error("OTP secret is required");
  }
  try {
    decodeBase32(value);
  } catch {
    throw new Error("OTP secret must be a valid base32 string");
  }
  return value;
}

export function generateTotpCode(
  secret: string,
  options: {
    for_time?: number;
    digits?: number;
    period?: number;
  } = {}
): string {
  const digits = options.digits ?? DEFAULT_TOTP_DIGITS;
  const period = options.period ?? DEFAULT_TOTP_PERIOD;
  const normalized = normalizeTotpSecret(secret);
  const key = decodeBase32(normalized);
  const counter = Math.floor((options.for_time ?? Date.now() / 1000) / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export function generateTotpCodeSafe(
  secret: string,
  options: {
    digits?: number;
    period?: number;
    min_remaining?: number;
  } = {}
): string {
  return generateTotpCodeSafeDetails(secret, options).code;
}

export function generateTotpCodeSafeDetails(
  secret: string,
  options: {
    digits?: number;
    period?: number;
    min_remaining?: number;
    now?: number;
  } = {}
): {
  code: string;
  for_time: number;
  expires_in_sec: number;
  digits: number;
  period: number;
} {
  const digits = options.digits ?? DEFAULT_TOTP_DIGITS;
  const period = options.period ?? DEFAULT_TOTP_PERIOD;
  const minRemaining = options.min_remaining ?? DEFAULT_TOTP_MIN_REMAINING;
  const now = options.now ?? Date.now() / 1000;
  const secondsRemaining = period - (now % period);
  const forTime = secondsRemaining < minRemaining ? now + secondsRemaining + 0.5 : now;
  const code = generateTotpCode(secret, {
    for_time: forTime,
    digits,
    period
  });
  const expiresInSec = Math.max(1, Math.ceil(period - (forTime % period)));
  return {
    code,
    for_time: forTime,
    expires_in_sec: expiresInSec,
    digits,
    period
  };
}

export function parseTotpSecretsDocument(text: string): Record<string, string> {
  const source = String(text ?? "").trim();
  if (!source) {
    return {};
  }
  if (source.startsWith("{")) {
    return parseTotpSecretsJson(source);
  }
  return parseTotpSecretsLines(source);
}

export async function loadTotpSecretsFile(filePath: string): Promise<Record<string, string>> {
  const targetPath = String(filePath ?? "").trim();
  if (!targetPath) {
    throw new Error("TOTP secrets file path is required");
  }
  const content = await readFile(targetPath, "utf8");
  return parseTotpSecretsDocument(content);
}

export async function getOtpCodeFromFile(
  login: string,
  filePath: string
): Promise<{
  login: string;
  code: string;
  expires_in_sec: number;
  period: number;
  digits: number;
}> {
  const normalizedLogin = String(login ?? "").trim();
  if (!normalizedLogin) {
    throw new Error("TOTP login is required");
  }
  const secrets = await loadTotpSecretsFile(filePath);
  const secret = secrets[normalizedLogin];
  if (!secret) {
    throw new Error(`TOTP secret not found for login: ${normalizedLogin}`);
  }
  const details = generateTotpCodeSafeDetails(secret);
  return {
    login: normalizedLogin,
    code: details.code,
    expires_in_sec: details.expires_in_sec,
    period: details.period,
    digits: details.digits
  };
}

export async function queryNtpDrift(timeoutMs = 3000): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const socket = dgram.createSocket("udp4");
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;
    const startedAt = Date.now();

    const onFailure = () => {
      try {
        socket.close();
      } catch {
        // noop
      }
      resolve(null);
    };

    const timer = setTimeout(onFailure, timeoutMs);

    socket.once("error", () => {
      clearTimeout(timer);
      onFailure();
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
        onFailure();
      }
    });

    socket.send(packet, 123, "pool.ntp.org", (error) => {
      if (error) {
        clearTimeout(timer);
        onFailure();
      }
    });
  });
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replaceAll("=", "")) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid base32");
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function parseTotpSecretsJson(text: string): Record<string, string> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [login, value] of Object.entries(parsed ?? {})) {
    const normalizedLogin = String(login ?? "").trim();
    if (!normalizedLogin) {
      continue;
    }
    const secret = extractSecretValue(value);
    if (!secret) {
      continue;
    }
    result[normalizedLogin] = normalizeTotpSecret(secret);
  }
  return result;
}

function parseTotpSecretsLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const separatorIndex = line.includes("=") ? line.indexOf("=") : line.indexOf(":");
    if (separatorIndex < 0) {
      throw new Error(`Invalid TOTP secrets line: ${line}`);
    }
    const login = line.slice(0, separatorIndex).trim();
    const secret = line.slice(separatorIndex + 1).trim();
    if (!login || !secret) {
      throw new Error(`Invalid TOTP secrets line: ${line}`);
    }
    result[login] = normalizeTotpSecret(secret);
  }
  return result;
}

function extractSecretValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const candidate = (value as { secret?: unknown }).secret;
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  return "";
}
