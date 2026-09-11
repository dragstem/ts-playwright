import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@ts-playwright/ui";
import { useAuth } from "../auth";
import { useT } from "../i18n";
import { useExecutionStream } from "../lib/useExecutionStream";
import { HealthIndicator } from "./HealthIndicator";
import { NotificationCenter } from "./NotificationCenter";
import { ProjectSwitcher } from "./ProjectSwitcher";

// Top-level chrome: brand, primary nav, and the signed-in user menu.
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { t, lang, setLang } = useT();
  // Live count of active runs across all projects (SSE), only while signed in.
  const execution = useExecutionStream(Boolean(user));
  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 24px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)"
        }}
      >
        <Link to="/dashboard" style={{ fontWeight: 700, color: "var(--text)" }}>
          ts-playwright
        </Link>
        {user && <ProjectSwitcher />}
        <nav style={{ display: "flex", gap: 12 }}>
          <Link to="/dashboard">{t("nav.dashboard")}</Link>
          <Link to="/projects">{t("nav.projects")}</Link>
          <Link to="/runs">{t("nav.runs")}</Link>
          <Link to="/batches">{t("nav.batches")}</Link>
          <Link to="/credentials">{t("nav.credentials")}</Link>
          <Link to="/merchants">{t("nav.merchants")}</Link>
          <Link to="/pools">{t("nav.pools")}</Link>
          <Link to="/tokens">{t("nav.tokens")}</Link>
          {user?.role === "admin" && (
            <>
              <Link to="/admin/users">{t("nav.users")}</Link>
              <Link to="/admin/audit">{t("nav.audit")}</Link>
            </>
          )}
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {user && <HealthIndicator />}
          {user && <NotificationCenter />}
          {user && execution.active > 0 && (
            <Link to="/runs" title={t("nav.running")} style={{ textDecoration: "none" }}>
              <span className="tsp-badge" data-status="running">
                ▶ {execution.active} {t("nav.running")}
              </span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => setLang(lang === "en" ? "ru" : "en")}
            title="Language"
            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", padding: "2px 8px" }}
          >
            {lang === "en" ? "RU" : "EN"}
          </button>
          {user && (
            <>
              <span style={{ color: "var(--text-muted)" }}>
                {user.login} · {user.role}
              </span>
              <Button onClick={() => void logout()}>{t("action.logout")}</Button>
            </>
          )}
        </div>
      </header>
      <main className="tsp-app">{children}</main>
    </div>
  );
}
