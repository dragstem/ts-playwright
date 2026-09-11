import { z } from "zod";

// Phase 2 / 2.3 — real tool-user identity (replaces the fake, passwordless cabinet_user).
// "User" = a person who logs into the tool. Distinct from "StandCredential" (the login/password/
// 2FA of a tested stand used in scenarios). Schemas live in shared so the server and the agent
// share one contract; the persistence store stays server-side.

export const UserRoleSchema = z.enum(["admin", "operator", "viewer"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserRecordSchema = z.object({
  id: z.string().min(1),
  login: z.string().min(1), // normalized (lowercased, trimmed) login / email
  display_name: z.string().default(""),
  password_hash: z.string().min(1),
  role: UserRoleSchema,
  status: UserStatusSchema.default("active"),
  created_at: z.string(),
  updated_at: z.string(),
  last_login_at: z.string().nullable().default(null),
  // Phase 2 / 2-R6 — Login MFA (TOTP). mfa_secret holds the confirmed base32 secret; pending_mfa_secret
  // is the unconfirmed one during enrollment; mfa_recovery_hashes are sha256 of one-time recovery codes.
  mfa_enabled: z.boolean().default(false),
  mfa_secret: z.string().nullable().default(null),
  pending_mfa_secret: z.string().nullable().default(null),
  mfa_recovery_hashes: z.array(z.string()).default([])
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const SessionRecordSchema = z.object({
  token: z.string().min(1),
  user_id: z.string().min(1),
  created_at: z.string(),
  expires_at: z.string(),
  last_seen_at: z.string()
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

// Personal Access Token (for the desktop agent). Only the hash is stored; the plaintext is
// shown once at creation time.
export const TokenRecordSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  label: z.string().default(""),
  token_hash: z.string().min(1),
  scope: z.string().default("agent"),
  created_at: z.string(),
  last_used_at: z.string().nullable().default(null)
});
export type TokenRecord = z.infer<typeof TokenRecordSchema>;

export interface PublicToken {
  id: string;
  label: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
}

export function toPublicToken(token: TokenRecord): PublicToken {
  return {
    id: token.id,
    label: token.label,
    scope: token.scope,
    created_at: token.created_at,
    last_used_at: token.last_used_at
  };
}

// Public (safe) projection — never leaks the password hash.
export interface PublicUser {
  id: string;
  login: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  mfa_enabled: boolean;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    login: user.login,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
    mfa_enabled: user.mfa_enabled
  };
}

export const RegisterBodySchema = z.object({
  login: z.string().min(1),
  password: z.string().min(8),
  display_name: z.string().optional()
});

export const LoginBodySchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1)
});

// Phase 2 / 2-R6 — second login step once a password is accepted for an MFA-enabled user.
export const MfaLoginBodySchema = z.object({
  mfa_token: z.string().min(1),
  code: z.string().min(1)
});

export const MfaCodeBodySchema = z.object({
  code: z.string().min(1)
});

export function normalizeLogin(login: string): string {
  return String(login ?? "").trim().toLowerCase();
}
