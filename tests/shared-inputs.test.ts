import { describe, expect, it } from "vitest";
import {
  DEFAULT_2FA_INPUT_NAME,
  OTP_2FA_INPUT_TYPE,
  STRING_INPUT_TYPE,
  extractInputPlaceholders,
  filterInputSpecs,
  normalizeInputSpecs
} from "@ts-playwright/shared";

describe("shared inputs", () => {
  it("defaults 2fa name to otp type", () => {
    const specs = normalizeInputSpecs([{ name: DEFAULT_2FA_INPUT_NAME }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      name: DEFAULT_2FA_INPUT_NAME,
      type: OTP_2FA_INPUT_TYPE,
      description: "",
      otp_login: ""
    });
  });

  it("preserves explicit otp login", () => {
    const specs = normalizeInputSpecs([
      { name: DEFAULT_2FA_INPUT_NAME, type: OTP_2FA_INPUT_TYPE, otp_login: "oleg" }
    ]);
    expect(specs[0]?.otp_login).toBe("oleg");
  });

  it("keeps only used placeholders", () => {
    const specs = filterInputSpecs(
      [
        { name: "user_name", type: STRING_INPUT_TYPE },
        { name: DEFAULT_2FA_INPUT_NAME, type: OTP_2FA_INPUT_TYPE, otp_login: "oleg" }
      ],
      ["user_name"]
    );
    expect(specs.map((item) => item.name)).toEqual(["user_name"]);
  });

  it("extracts unique placeholders in order", () => {
    const names = extractInputPlaceholders(
      'await page.fill("#a", "{{INPUT:user_name}}");\nawait page.fill("#b", "{{INPUT:user_name}}");\nawait page.fill("#c", "{{INPUT:2fa_otp}}");'
    );
    expect(names).toEqual(["user_name", "2fa_otp"]);
  });
});
