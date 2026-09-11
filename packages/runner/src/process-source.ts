import {
  AUTH_STATE_FILE_NAME,
  DEFAULT_2FA_INPUT_NAME,
  OTP_2FA_INPUT_TYPE,
  SERVER_2FA_OTP_INPUT_NAME
} from "@ts-playwright/shared";

const IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+['"](?:@playwright\/test|\.\/pw-runtime)['"];?/;
const PLACEHOLDER_RE = /(['"])\{\{INPUT:([\p{L}\p{N}_]+)\}\}\1|\{\{INPUT:([\p{L}\p{N}_]+)\}\}/gu;
const SERVER_PLACEHOLDER_RE =
  /(['"])\{(server_username|server_password|server_2faotp|server_merchant)\}\1|\{(server_username|server_password|server_2faotp|server_merchant)\}/gu;
const OPTION_ROLE_PROPS_RE = /(getByRole\(\s*(['"])option\2\s*,\s*\{)([^{}]*?)(\}\s*\))/gs;
const SERVER_INPUT_CALL_RE = /input\(\s*(['"])(server_username|server_password|server_2faotp|server_merchant)\1\s*\)/g;
const ANONYMOUS_COMBOBOX_CLICK_RE = /page\.getByRole\(\s*(['"])combobox\1\s*\)\.click\(/;
const EMPTY_LABEL_CLICK_RE = /page\.getByLabel\(\s*(['"])\s*\1\s*,\s*\{\s*exact\s*:\s*true\s*\}\s*\)\.click\(/;
const COMBOBOX_OPTION_CLICK_RE =
  /(^[ \t]*)await\s+page\.getByRole\(\s*(['"])combobox\2\s*\)\.click\(\s*\);\s*(?:\r?\n\1await\s+waitForGraphQLIdle\(page\);\s*)?\r?\n\1await\s+page\.getByRole\(\s*(['"])option\3\s*,\s*\{\s*name\s*:\s*(['"])([^'"]+)\4\s*(?:,\s*exact\s*:\s*(true|false)\s*)?\}\s*\)\.click\(\s*\);/gm;
const EMPTY_LABEL_OPTION_CLICK_RE =
  /(^[ \t]*)await\s+page\.getByLabel\(\s*(['"])\s*\2\s*,\s*\{\s*exact\s*:\s*true\s*\}\s*\)\.click\(\s*\);\s*(?:\r?\n\1await\s+waitForGraphQLIdle\(page\);\s*)?\r?\n\1await\s+page\.getByRole\(\s*(['"])option\3\s*,\s*\{\s*name\s*:\s*(['"])([^'"]+)\4\s*(?:,\s*exact\s*:\s*(true|false)\s*)?\}\s*\)\.click\(\s*\);/gm;
const INPUT_FILL_METHOD_RE =
  /^([ \t]*)await\s+(.+)\.fill\(\s*((?:await\s+)?input\(\s*["'][\p{L}\p{N}_]+["']\s*\))\s*(,\s*.+?)?\s*\);\s*$/u;
const PAGE_INPUT_FILL_RE =
  /^([ \t]*)await\s+page\.fill\(\s*(.+?)\s*,\s*((?:await\s+)?input\(\s*["'][\p{L}\p{N}_]+["']\s*\))\s*(,\s*.+?)?\s*\);\s*$/u;

export interface CodegenDiagnostic {
  code: string;
  severity: "info" | "warning";
  message: string;
  line: number;
  snippet: string;
}

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

export function forceExactOptionNameMatches(source: string): string {
  return source.replace(OPTION_ROLE_PROPS_RE, (match, prefix, _quote, props, suffix) => {
    if (/\bexact\s*:/s.test(props)) {
      return match;
    }
    if (!/\bname\s*:\s*(["']).*?\1/s.test(props)) {
      return match;
    }

    const trimmed = props.trimEnd();
    const trailingWhitespace = props.slice(trimmed.length);
    let nextProps = trimmed;
    if (!nextProps) {
      nextProps = "exact: true";
    } else if (nextProps.endsWith(",")) {
      nextProps = `${nextProps} exact: true`;
    } else {
      nextProps = `${nextProps}, exact: true`;
    }
    return `${prefix}${nextProps}${trailingWhitespace}${suffix}`;
  });
}

export function analyzeCodegenSource(source: string): CodegenDiagnostic[] {
  const diagnostics: CodegenDiagnostic[] = [];
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (/getByLabel\(\s*(['"])\s*\1\s*,\s*\{\s*exact\s*:\s*true\s*\}/.test(line)) {
      diagnostics.push({
        code: "empty-label-locator",
        severity: "warning",
        message: "Recorded locator uses an empty accessible label. It can be brittle when the UI re-renders.",
        line: lineNumber,
        snippet: line.trim()
      });
    }
    if (/\.(first|last|nth)\(/.test(line)) {
      diagnostics.push({
        code: "positional-locator",
        severity: "info",
        message: "Recorded locator depends on element position. Prefer a stable role, label, text, or test id when this becomes flaky.",
        line: lineNumber,
        snippet: line.trim()
      });
    }
    if (/\.dblclick\(/.test(line)) {
      diagnostics.push({
        code: "double-click",
        severity: "info",
        message: "Recorded double click can be timing-sensitive in remote browsers.",
        line: lineNumber,
        snippet: line.trim()
      });
    }
    if (ANONYMOUS_COMBOBOX_CLICK_RE.test(line)) {
      diagnostics.push({
        code: "anonymous-combobox-locator",
        severity: "warning",
        message:
          "Recorded combobox locator has no accessible name. The runtime will try to stabilize adjacent option clicks, but named or test-id selectors are preferred.",
        line: lineNumber,
        snippet: line.trim()
      });
    }
  }
  return diagnostics;
}

export function detectRequiredServerInputs(source: string): string[] {
  const found = new Set<string>();
  SERVER_PLACEHOLDER_RE.lastIndex = 0;
  SERVER_INPUT_CALL_RE.lastIndex = 0;
  for (const match of source.matchAll(SERVER_PLACEHOLDER_RE)) {
    found.add(match[2] || match[3]);
  }
  for (const match of source.matchAll(SERVER_INPUT_CALL_RE)) {
    found.add(match[2]);
  }
  return [...found].sort();
}

export function injectInputCalls(source: string, asyncInputNames: Iterable<string> = [DEFAULT_2FA_INPUT_NAME]): string {
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(source)) {
    return repairDanglingInputCallQuotes(source);
  }
  PLACEHOLDER_RE.lastIndex = 0;
  const asyncNames = new Set<string>(asyncInputNames);
  const next = source.replace(PLACEHOLDER_RE, (_whole, _quoted, quotedName, rawName) => {
    const name = quotedName || rawName;
    return asyncNames.has(name) ? `await input(${JSON.stringify(name)})` : `input(${JSON.stringify(name)})`;
  });
  return ensureRuntimeImport(repairDanglingInputCallQuotes(next), true);
}

export function injectServerInputCalls(
  source: string,
  asyncInputNames: Iterable<string> = [SERVER_2FA_OTP_INPUT_NAME]
): string {
  SERVER_PLACEHOLDER_RE.lastIndex = 0;
  if (!SERVER_PLACEHOLDER_RE.test(source)) {
    return repairDanglingInputCallQuotes(source);
  }
  SERVER_PLACEHOLDER_RE.lastIndex = 0;
  const asyncNames = new Set<string>(asyncInputNames);
  const next = source.replace(SERVER_PLACEHOLDER_RE, (_whole, _quoted, quotedName, rawName) => {
    const name = quotedName || rawName;
    return asyncNames.has(name) ? `await input(${JSON.stringify(name)})` : `input(${JSON.stringify(name)})`;
  });
  return ensureRuntimeImport(repairDanglingInputCallQuotes(next), true);
}

export function injectAppReadyWaits(source: string): string {
  if (!/\bpage\.goto\(/.test(source)) {
    return source;
  }
  const next = source
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!/\bawait\s+page\.goto\(/.test(line)) {
        return [line];
      }
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return [line, `${indent}await waitForAppReady(page);`];
    })
    .join("\n");
  return ensureRuntimeImport(next, false, ["waitForAppReady"]);
}

export function injectGraphQLIdleWaits(source: string): string {
  if (!/\.(click|press)\(/.test(source)) {
    return source;
  }
  const next = source
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!/\bawait\b.*\.(click|press)\(/.test(line)) {
        return [line];
      }
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return [line, `${indent}await waitForGraphQLIdle(page);`];
    })
    .join("\n");
  return ensureRuntimeImport(next, false, ["waitForGraphQLIdle"]);
}

export function injectPassAwareInputFills(source: string): string {
  let changed = false;
  const next = source
    .split(/\r?\n/)
    .map((line) => {
      const pageFillMatch = line.match(PAGE_INPUT_FILL_RE);
      if (pageFillMatch) {
        changed = true;
        const [, indent, selector, value, options = ""] = pageFillMatch;
        return `${indent}await fillIfNotPass(page.locator(${selector}), ${value}${options});`;
      }

      const methodFillMatch = line.match(INPUT_FILL_METHOD_RE);
      if (methodFillMatch) {
        changed = true;
        const [, indent, target, value, options = ""] = methodFillMatch;
        return `${indent}await fillIfNotPass(${target}, ${value}${options});`;
      }

      return line;
    })
    .join("\n");
  return changed ? ensureRuntimeImport(next, false, ["fillIfNotPass"]) : source;
}

export function stabilizeAnonymousComboboxSelections(source: string): string {
  if (
    (!ANONYMOUS_COMBOBOX_CLICK_RE.test(source) && !EMPTY_LABEL_CLICK_RE.test(source)) ||
    !/\bgetByRole\(\s*(['"])option\1/.test(source)
  ) {
    return source;
  }

  let replaced = false;
  const replaceAnonymousOptionClick = (
    _match: string,
    indent: string,
    _triggerQuote: string,
    _optionQuote: string,
    _nameQuote: string,
    optionName: string,
    exact?: string
  ) => {
    replaced = true;
    const exactValue = exact === "false" ? "false" : "true";
    return `${indent}await selectComboboxOption(page, ${JSON.stringify(optionName)}, { exact: ${exactValue} });`;
  };
  const replaceEmptyLabelOptionClick = (
    _match: string,
    indent: string,
    _triggerQuote: string,
    _optionQuote: string,
    _nameQuote: string,
    optionName: string,
    exact?: string
  ) => {
    replaced = true;
    const exactValue = exact === "false" ? "false" : "true";
    return `${indent}await selectComboboxOption(page, ${JSON.stringify(optionName)}, { exact: ${exactValue}, locator: page.getByLabel('', { exact: true }) });`;
  };
  const next = source
    .replace(COMBOBOX_OPTION_CLICK_RE, replaceAnonymousOptionClick)
    .replace(EMPTY_LABEL_OPTION_CLICK_RE, replaceEmptyLabelOptionClick);

  return replaced ? ensureRuntimeImport(next, false, ["selectComboboxOption"]) : source;
}

export function prepareScenarioSource(
  source: string,
  options: {
    base_url: string;
    otp_autoreplace?: boolean;
    async_input_names?: string[];
  }
): string {
  let next = source;
  next = rewriteLegacyOtpPlaceholders(next);
  next = autoReplaceOtpFills(next, options.otp_autoreplace);
  next = forceExactOptionNameMatches(next);
  next = stabilizeAnonymousComboboxSelections(next);
  next = injectInputCalls(next, [DEFAULT_2FA_INPUT_NAME, ...(options.async_input_names ?? [])]);
  next = injectServerInputCalls(next, [SERVER_2FA_OTP_INPUT_NAME]);
  next = injectPassAwareInputFills(next);
  next = injectAppReadyWaits(next);
  next = injectGraphQLIdleWaits(next);
  next = ensureRuntimeImport(next, false);
  return next.replaceAll("BASE_URL", options.base_url.replace(/\/+$/g, ""));
}

export function ensureRuntimeImport(source: string, needsInput: boolean, extraNames: string[] = []): string {
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
    for (const name of extraNames) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    const uniqueNames = [...new Set(names)];
    return source.replace(IMPORT_RE, `import { ${uniqueNames.join(", ")} } from "./pw-runtime";`);
  }

  const imports = ["test", "expect"];
  if (needsInput) {
    imports.push("input");
  }
  imports.push(...extraNames);
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

function repairDanglingInputCallQuotes(source: string): string {
  return source.replace(
    /\b((?:await\s+)?input\(\s*(["'])[\p{L}\p{N}_]+\2\s*\))(['"])(?=\s*[,)\]}])/gu,
    "$1"
  );
}
