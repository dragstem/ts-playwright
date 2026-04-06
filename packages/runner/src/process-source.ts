import { AUTH_STATE_FILE_NAME, DEFAULT_2FA_INPUT_NAME, OTP_2FA_INPUT_TYPE } from "@ts-playwright/shared";

const IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+['"](?:@playwright\/test|\.\/pw-runtime)['"];?/;
const PLACEHOLDER_RE = /(['"])\{\{INPUT:([\p{L}\p{N}_]+)\}\}\1|\{\{INPUT:([\p{L}\p{N}_]+)\}\}/gu;

export function replaceBaseUrl(source: string, recordedBaseUrl: string): string {
  if (source.includes("http://localhost") || source.includes("https://localhost")) {
    throw new Error("Localhost URLs are not allowed");
  }
  if (!recordedBaseUrl) {
    return source;
  }
  const escaped = escapeRegExp(recordedBaseUrl.replace(/\/+$/g, ""));
  return source.replace(new RegExp(escaped, "g"), "BASE_URL");
}

export function detectForeignDomains(source: string, allowedBaseUrl: string): string[] {
  try {
    const allowedHost = new URL(allowedBaseUrl).hostname;
    if (!allowedHost) {
      return [];
    }
    const found = new Set<string>();
    const matches = source.match(/https?:\/\/[^\s'"\\)]+/g) ?? [];
    for (const url of matches) {
      try {
        const host = new URL(url).hostname;
        if (host && host !== allowedHost && host !== "localhost" && host !== "127.0.0.1") {
          found.add(host);
        }
      } catch {
        // Ignore malformed URLs in comments or template strings.
      }
    }
    return [...found].sort();
  } catch {
    return [];
  }
}

export function rewriteLegacyOtpPlaceholders(source: string): string {
  const placeholder = `{{INPUT:${DEFAULT_2FA_INPUT_NAME}}}`;
  let next = source;
  for (const legacyValue of ["OTP_CODE", "TOTP_CODE", "{{OTP}}"]) {
    next = next.replaceAll(`"${legacyValue}"`, `"${placeholder}"`);
    next = next.replaceAll(`'${legacyValue}'`, `'${placeholder}'`);
  }
  return next;
}

export function autoReplaceOtpFills(source: string, enabled?: boolean): string {
  const keywords = [
    "twofactorauthtoken",
    "verification code",
    "verificationcode",
    "verification_code",
    "2fa code",
    "2facode",
    "2fa_code"
  ];
  const shouldEnable = enabled ?? keywords.some((keyword) => source.toLowerCase().includes(keyword));
  if (!shouldEnable) {
    return source;
  }

  const lines = source.split(/\r?\n/);
  const updated: string[] = [];
  let pendingKeyword = false;
  let pendingFill = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    let nextLine = line;

    if (pendingFill) {
      nextLine = nextLine.replace(/(['"]).*?\1/, `"{{INPUT:${DEFAULT_2FA_INPUT_NAME}}}"`);
      if (nextLine.includes(")")) {
        pendingFill = false;
      }
      updated.push(nextLine);
      continue;
    }

    if (pendingKeyword) {
      const stripped = nextLine.trimStart();
      if (stripped.startsWith(".") && lower.includes(".fill(")) {
        if (nextLine.includes(")")) {
          nextLine = nextLine.replace(/\.fill\(\s*.*?\)/i, `.fill("{{INPUT:${DEFAULT_2FA_INPUT_NAME}}}")`);
        } else {
          pendingFill = true;
        }
        pendingKeyword = false;
        updated.push(nextLine);
        continue;
      }
      if (!stripped.startsWith(".")) {
        pendingKeyword = false;
      }
    }

    if (keywords.some((keyword) => lower.includes(keyword))) {
      if (lower.includes(".fill(")) {
        if (nextLine.includes(")")) {
          nextLine = nextLine.replace(/\.fill\(\s*.*?\)/i, `.fill("{{INPUT:${DEFAULT_2FA_INPUT_NAME}}}")`);
        } else {
          pendingFill = true;
        }
      } else {
        pendingKeyword = true;
      }
    }

    updated.push(nextLine);
  }

  return updated.join("\n");
}

export function injectInputCalls(source: string): string {
  if (!PLACEHOLDER_RE.test(source)) {
    return source;
  }
  const next = source.replace(PLACEHOLDER_RE, (_whole, _quoted, quotedName, rawName) => {
    const name = quotedName || rawName;
    return `input(${JSON.stringify(name)})`;
  });
  return ensureRuntimeImport(next, true);
}

export function prepareScenarioSource(
  source: string,
  options: {
    base_url: string;
    otp_autoreplace?: boolean;
  }
): string {
  let next = source;
  next = rewriteLegacyOtpPlaceholders(next);
  next = autoReplaceOtpFills(next, options.otp_autoreplace);
  next = injectInputCalls(next);
  next = ensureRuntimeImport(next, false);
  return next.replaceAll("BASE_URL", options.base_url.replace(/\/+$/g, ""));
}

export function ensureRuntimeImport(source: string, needsInput: boolean): string {
  const match = source.match(IMPORT_RE);
  if (match) {
    const names = match[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!names.includes("test")) {
      names.unshift("test");
    }
    if (!names.includes("expect")) {
      names.push("expect");
    }
    if (needsInput && !names.includes("input")) {
      names.push("input");
    }
    const uniqueNames = [...new Set(names)];
    return source.replace(IMPORT_RE, `import { ${uniqueNames.join(", ")} } from "./pw-runtime";`);
  }

  const imports = ["test", "expect"];
  if (needsInput) {
    imports.push("input");
  }
  return `import { ${imports.join(", ")} } from "./pw-runtime";\n${source}`;
}

export function normalizeAuthStateRef(sourcePath: string): string {
  return sourcePath ? AUTH_STATE_FILE_NAME : AUTH_STATE_FILE_NAME;
}

export function isOtpInputType(inputType: string): boolean {
  return inputType === OTP_2FA_INPUT_TYPE;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
