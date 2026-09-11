import type { ReactNode } from "react";

export interface TabSpec {
  id: string;
  label: ReactNode;
}

// Minimal controlled tab strip. The caller owns the active id and renders the panel; this is just
// the button row so it stays layout-agnostic.
export function Tabs({
  tabs,
  active,
  onChange
}: {
  tabs: TabSpec[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 16 }}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: `2px solid ${selected ? "var(--accent, var(--status-running))" : "transparent"}`,
              color: selected ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              fontWeight: selected ? 600 : 400,
              padding: "8px 12px"
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
