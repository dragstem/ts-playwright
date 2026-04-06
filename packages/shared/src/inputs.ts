import {
  DEFAULT_2FA_INPUT_NAME,
  OTP_2FA_INPUT_TYPE,
  STRING_INPUT_TYPE,
  SUPPORTED_INPUT_TYPES
} from "./constants";
import type { InputSpec } from "./schemas";

const INPUT_NAME_PATTERN = /^[\p{L}\p{N}_]+$/u;
const INPUT_PLACEHOLDER_PATTERN = /\{\{INPUT:([\p{L}\p{N}_]+)\}\}/gu;

export function normalizeInputName(name: unknown): string {
  const value = String(name ?? "").trim();
  if (!value || !INPUT_NAME_PATTERN.test(value)) {
    return "";
  }
  return value;
}

export function normalizeInputType(inputType: unknown, fallbackName = ""): typeof SUPPORTED_INPUT_TYPES[number] {
  const value = String(inputType ?? "").trim().toLowerCase();
  if (SUPPORTED_INPUT_TYPES.includes(value as typeof SUPPORTED_INPUT_TYPES[number])) {
    return value as typeof SUPPORTED_INPUT_TYPES[number];
  }
  if (normalizeInputName(fallbackName) === DEFAULT_2FA_INPUT_NAME) {
    return OTP_2FA_INPUT_TYPE;
  }
  return STRING_INPUT_TYPE;
}

export function normalizeOtpLogin(login: unknown): string {
  return String(login ?? "").trim();
}

export function extractInputPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of text.matchAll(INPUT_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function buildInputSpec(
  name: string,
  options: {
    input_type?: string | null;
    description?: string;
    otp_login?: string;
  } = {}
): InputSpec {
  const normalizedName = normalizeInputName(name);
  if (!normalizedName) {
    throw new Error("Invalid input name");
  }

  const type = normalizeInputType(options.input_type ?? "", normalizedName);
  return {
    name: normalizedName,
    type,
    description: String(options.description ?? "").trim(),
    otp_login: type === OTP_2FA_INPUT_TYPE ? normalizeOtpLogin(options.otp_login) : ""
  };
}

export function normalizeInputSpecs(inputs: unknown): InputSpec[] {
  const normalized: InputSpec[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(inputs)) {
    return normalized;
  }

  for (const item of inputs) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const name = normalizeInputName(raw.name);
    if (!name || seen.has(name)) {
      continue;
    }
    normalized.push(
      buildInputSpec(name, {
        input_type: String(raw.type ?? raw.source ?? "").trim() || null,
        description: String(raw.description ?? "").trim(),
        otp_login: String(raw.otp_login ?? "")
      })
    );
    seen.add(name);
  }

  return normalized;
}

export function filterInputSpecs(inputs: unknown, names: Iterable<string>): InputSpec[] {
  const allowed = new Set<string>();
  for (const name of names) {
    const normalized = normalizeInputName(name);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  if (allowed.size === 0) {
    return [];
  }
  return normalizeInputSpecs(inputs).filter((spec) => allowed.has(spec.name));
}
