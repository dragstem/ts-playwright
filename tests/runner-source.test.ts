import { describe, expect, it } from "vitest";
import {
  analyzeCodegenSource,
  autoReplaceOtpFills,
  buildRuntimeModule,
  detectRequiredServerInputs,
  forceExactOptionNameMatches,
  injectAppReadyWaits,
  injectGraphQLIdleWaits,
  injectInputCalls,
  injectPassAwareInputFills,
  injectServerInputCalls,
  prepareScenarioSource,
  rewriteLegacyOtpPlaceholders,
  stabilizeAnonymousComboboxSelections
} from "@ts-playwright/runner";

describe("runner source transforms", () => {
  it("injects input helper for placeholders", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      '  await page.fill("#login", "{{INPUT:user_name}}");',
      "});"
    ].join("\n");

    const result = injectInputCalls(source);
    expect(result).toContain('import { test, expect, input } from "./pw-runtime";');
    expect(result).toContain('await page.fill("#login", input("user_name"));');
  });

  it("keeps derivation path placeholders as runtime inputs so apostrophes stay in data", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      '  await page.getByRole("textbox", { name: "Derivation path" }).fill("{{INPUT:derivation_path}}");',
      "});"
    ].join("\n");

    const result = injectInputCalls(source);
    expect(result).toContain(
      'await page.getByRole("textbox", { name: "Derivation path" }).fill(input("derivation_path"));'
    );
  });

  it("repairs dangling quotes after runtime input calls from malformed recorded source", () => {
    const source =
      'await page.getByRole("textbox", { name: "Derivation path" }).fill(input("derivation_path")\');';

    const result = prepareScenarioSource(source, { base_url: "https://example.test" });
    expect(result).toContain(
      'await fillIfNotPass(page.getByRole("textbox", { name: "Derivation path" }), input("derivation_path"));'
    );
    expect(result).not.toContain('input("derivation_path")\'');
  });

  it("awaits otp placeholders so Playwright receives a string instead of a promise", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      '  await page.fill("#otp", "{{INPUT:2fa_otp}}");',
      "});"
    ].join("\n");

    const result = injectInputCalls(source);
    expect(result).toContain('await page.fill("#otp", await input("2fa_otp"));');
  });

  it("awaits custom otp inputs when metadata marks them as 2fa", () => {
    const source = 'await page.fill("#otp", "{{INPUT:secure_code}}");';
    const result = prepareScenarioSource(source, {
      base_url: "https://example.test",
      async_input_names: ["secure_code"]
    });
    expect(result).toContain('await fillIfNotPass(page.locator("#otp"), await input("secure_code"));');
  });

  it("wraps input fills so PASS can skip entering a value", () => {
    const source = [
      'await page.getByRole("textbox", { name: "Login" }).fill(input("user_name"));',
      'await page.fill("#otp", await input("2fa_otp"));'
    ].join("\n");

    const result = injectPassAwareInputFills(source);

    expect(result).toContain('import { test, expect, fillIfNotPass } from "./pw-runtime";');
    expect(result).toContain('await fillIfNotPass(page.getByRole("textbox", { name: "Login" }), input("user_name"));');
    expect(result).toContain('await fillIfNotPass(page.locator("#otp"), await input("2fa_otp"));');
  });

  it("prepares recorded input fills with PASS-aware runtime helper", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      '  await page.getByRole("textbox", { name: "Login" }).fill("{{INPUT:user_name}}");',
      '  await page.fill("#otp", "{{INPUT:2fa_otp}}");',
      "});"
    ].join("\n");

    const result = prepareScenarioSource(source, { base_url: "https://example.test" });

    expect(result).toContain("fillIfNotPass");
    expect(result).toContain('await fillIfNotPass(page.getByRole("textbox", { name: "Login" }), input("user_name"));');
    expect(result).toContain('await fillIfNotPass(page.locator("#otp"), await input("2fa_otp"));');
  });

  it("injects server account placeholders as runtime inputs", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      '  await page.fill("#login", "{server_username}");',
      '  await page.fill("#password", "{server_password}");',
      "});"
    ].join("\n");

    const result = injectServerInputCalls(source);
    expect(result).toContain('await page.fill("#login", input("server_username"));');
    expect(result).toContain('await page.fill("#password", input("server_password"));');
  });

  it("awaits server 2fa placeholders so runtime can generate a live code", () => {
    const source = 'await page.fill("#otp", "{server_2faotp}");';
    const result = prepareScenarioSource(source, {
      base_url: "https://example.test"
    });
    expect(result).toContain('await fillIfNotPass(page.locator("#otp"), await input("server_2faotp"));');
  });

  it("rewrites legacy otp placeholders", () => {
    const source = 'await page.fill("#otp", "OTP_CODE");';
    expect(rewriteLegacyOtpPlaceholders(source)).toContain("{{INPUT:2fa_otp}}");
  });

  it("auto replaces otp fills by selector hint", () => {
    const source = 'await page.locator("input.twoFactorAuthToken").fill("123456");';
    expect(autoReplaceOtpFills(source, true)).toContain('fill("{{INPUT:2fa_otp}}")');
  });

  it("makes option name lookups exact to avoid substring collisions", () => {
    const source = "await page.getByRole('option', { name: 'Ethereum' }).click();";
    expect(forceExactOptionNameMatches(source)).toContain(
      "getByRole('option', { name: 'Ethereum', exact: true })"
    );
  });

  it("keeps explicit exact option lookups unchanged", () => {
    const source = "await page.getByRole('option', { name: 'Ethereum', exact: true }).click();";
    expect(forceExactOptionNameMatches(source)).toBe(source);
  });

  it("does not change non-option role lookups", () => {
    const source = "await page.getByRole('button', { name: 'Create deposit' }).click();";
    expect(forceExactOptionNameMatches(source)).toBe(source);
  });

  it("adds app and graphql stability waits to recorded flows", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      "  await page.goto('BASE_URL/');",
      "  await page.getByRole('button', { name: 'Log In' }).click();",
      "});"
    ].join("\n");

    const result = prepareScenarioSource(source, { base_url: "https://example.test" });
    expect(result).toContain("waitForAppReady");
    expect(result).toContain("await waitForAppReady(page);");
    expect(result).toContain("waitForGraphQLIdle");
    expect(result).toContain("await waitForGraphQLIdle(page);");
  });

  it("keeps app-ready and graphql wait transforms available independently", () => {
    expect(injectAppReadyWaits("await page.goto('https://example.test');")).toContain("waitForAppReady");
    expect(injectGraphQLIdleWaits("await page.locator('#submit').click();")).toContain("waitForGraphQLIdle");
  });

  it("stabilizes anonymous combobox selection using the following option name", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('demo', async ({ page }) => {",
      "  await page.getByRole('combobox').click();",
      "  await page.getByRole('option', { name: 'Manual deposit', exact: true }).click();",
      "});"
    ].join("\n");

    const result = stabilizeAnonymousComboboxSelections(source);
    expect(result).toContain('import { test, expect, selectComboboxOption } from "./pw-runtime";');
    expect(result).toContain('await selectComboboxOption(page, "Manual deposit", { exact: true });');
    expect(result).not.toContain("getByRole('combobox').click()");
  });

  it("stabilizes anonymous combobox selections after prior wait injection", () => {
    const source = [
      "await page.getByRole('combobox').click();",
      "await waitForGraphQLIdle(page);",
      "await page.getByRole('option', { name: 'Manual deposit', exact: true }).click();"
    ].join("\n");

    const result = stabilizeAnonymousComboboxSelections(source);
    expect(result).toContain('await selectComboboxOption(page, "Manual deposit", { exact: true });');
    expect(result).not.toContain("await waitForGraphQLIdle(page);");
  });

  it("stabilizes empty-label select clicks using the following option name", () => {
    const source = [
      "await page.getByLabel('', { exact: true }).click();",
      "await page.getByRole('option', { name: '{server_merchant}', exact: true }).click();"
    ].join("\n");

    const result = stabilizeAnonymousComboboxSelections(source);
    expect(result).toContain(
      'await selectComboboxOption(page, "{server_merchant}", { exact: true, locator: page.getByLabel(\'\', { exact: true }) });'
    );
    expect(result).not.toContain("getByLabel('', { exact: true }).click()");
  });

  it("detects server placeholders before execution", () => {
    const source = [
      'await page.fill("#login", "{server_username}");',
      'await page.fill("#otp", await input("server_2faotp"));'
    ].join("\n");

    expect(detectRequiredServerInputs(source)).toEqual(["server_2faotp", "server_username"]);
  });

  it("records advisory diagnostics for brittle codegen locators", () => {
    const diagnostics = analyzeCodegenSource(
      [
        "await page.getByLabel('', { exact: true }).click();",
        "await page.locator('#menu div').first().click();",
        "await page.getByRole('option', { name: 'merchant' }).dblclick();",
        "await page.getByRole('combobox').click();"
      ].join("\n")
    );

    expect(diagnostics.map((item) => item.code)).toEqual([
      "empty-label-locator",
      "positional-locator",
      "double-click",
      "anonymous-combobox-locator"
    ]);
  });

  it("resolves datetime input presets inside the runtime module", () => {
    const source = buildRuntimeModule();

    expect(source).toContain("const runtimeStartedAt = new Date();");
    expect(source).toContain('raw.replaceAll("{datetime}", runtimeDatetimeSuffix())');
    expect(source).toContain("resolveRuntimeInputPresets");
  });
});
