import { createHmac } from "node:crypto";
import dgram from "node:dgram";

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
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
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
  const period = options.period ?? 30;
  const minRemaining = options.min_remaining ?? 20;
  const now = Date.now() / 1000;
  const secondsRemaining = period - (now % period);
  const forTime = secondsRemaining < minRemaining ? now + secondsRemaining + 0.5 : now;
  return generateTotpCode(secret, {
    for_time: forTime,
    digits: options.digits,
    period
  });
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
