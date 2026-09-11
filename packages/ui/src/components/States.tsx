import type { ReactNode } from "react";

// Shared empty / loading / error placeholders so every screen renders these states the same way.

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <p style={{ color: "var(--text-muted)" }} role="status">
      {label}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p style={{ color: "var(--text-muted)" }}>{children}</p>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p style={{ color: "var(--status-failed)" }} role="alert">
      {message}
    </p>
  );
}
