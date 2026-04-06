export const DEFAULT_2FA_INPUT_NAME = "2fa_otp";
export const STRING_INPUT_TYPE = "string";
export const OTP_2FA_INPUT_TYPE = "2fa_otp";
export const SUPPORTED_INPUT_TYPES = [STRING_INPUT_TYPE, OTP_2FA_INPUT_TYPE] as const;

export const STORAGE_SCHEMA_VERSION = 1;
export const PACKAGE_FILENAME = "package.zip";
export const RUNS_DIRNAME = "runs";
export const SCENARIO_FILE_NAME = "scenario.spec.ts";
export const METADATA_FILE_NAME = "metadata.json";
export const AUTH_STATE_FILE_NAME = "auth_state.json";

export const DEFAULT_BROWSER = "chromium";
export const DEFAULT_LOCALE = "ru-RU";
export const DEFAULT_TIMEZONE = "Europe/Riga";
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
export const DEFAULT_DOCKER_IMAGE = "mcr.microsoft.com/playwright:v1.52.0-jammy";

export const DEFAULT_OTP_ACCOUNTS = [
  { login: "boba", secret: "JBSWY3DPEHPK3PXP" },
  { login: "biba", secret: "KRUGS4ZANFZSAYJA" },
  { login: "oleg", secret: "MFRGGZDFMZTWQ2LK" }
] as const;
