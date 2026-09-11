export const DEFAULT_2FA_INPUT_NAME = "2fa_otp";
export const STRING_INPUT_TYPE = "string";
export const OTP_2FA_INPUT_TYPE = "2fa_otp";
export const SUPPORTED_INPUT_TYPES = [STRING_INPUT_TYPE, OTP_2FA_INPUT_TYPE] as const;

export const SERVER_USERNAME_INPUT_NAME = "server_username";
export const SERVER_PASSWORD_INPUT_NAME = "server_password";
export const SERVER_2FA_OTP_INPUT_NAME = "server_2faotp";
export const SERVER_MERCHANT_INPUT_NAME = "server_merchant";
export const SERVER_INPUT_NAMES = [
  SERVER_USERNAME_INPUT_NAME,
  SERVER_PASSWORD_INPUT_NAME,
  SERVER_2FA_OTP_INPUT_NAME,
  SERVER_MERCHANT_INPUT_NAME
] as const;
export const SERVER_INPUT_TOKENS = {
  username: `{${SERVER_USERNAME_INPUT_NAME}}`,
  password: `{${SERVER_PASSWORD_INPUT_NAME}}`,
  two_factor_otp: `{${SERVER_2FA_OTP_INPUT_NAME}}`,
  merchant: `{${SERVER_MERCHANT_INPUT_NAME}}`
} as const;

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
export const DEFAULT_PLAYWRIGHT_VERSION = "1.52.0";
export const DEFAULT_DOCKER_IMAGE = "mcr.microsoft.com/playwright:v1.52.0-jammy";
