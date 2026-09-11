import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicUser } from "@ts-playwright/shared";
import { api, ApiError } from "./api";

interface LoginResult {
  mfa_required?: boolean;
  mfa_token?: string;
}

interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<LoginResult>;
  loginMfa: (mfaToken: string, code: string) => Promise<void>;
  register: (login: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within <AuthProvider>");
  }
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      try {
        return await api.get<PublicUser>("/api/auth/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          return null;
        }
        throw error;
      }
    }
  });

  const login = async (login: string, password: string): Promise<LoginResult> => {
    const res = await api.post<LoginResult>("/api/auth/login", { login, password });
    if (res?.mfa_required) {
      // No session yet — the caller collects a second factor and calls loginMfa().
      return res;
    }
    await qc.invalidateQueries({ queryKey: ["me"] });
    return {};
  };
  const loginMfa = async (mfaToken: string, code: string) => {
    await api.post("/api/auth/login/mfa", { mfa_token: mfaToken, code });
    await qc.invalidateQueries({ queryKey: ["me"] });
  };
  const register = async (login: string, password: string, displayName?: string) => {
    await api.post("/api/auth/register", { login, password, display_name: displayName });
    await qc.invalidateQueries({ queryKey: ["me"] });
  };
  const logout = async () => {
    await api.post("/api/auth/logout");
    qc.setQueryData(["me"], null);
  };

  return (
    <AuthContext.Provider value={{ user: me.data ?? null, loading: me.isLoading, login, loginMfa, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
