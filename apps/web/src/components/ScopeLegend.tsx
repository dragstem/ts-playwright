// Explains the three variable scopes so users know where a value applies. Reused on the cabinet
// screens (accounts/merchants/pools) and the project Settings tab.
export function ScopeLegend() {
  const item = (badge: string, status: string, text: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
      <span className="tsp-badge" data-status={status}>
        {badge}
      </span>
      {text}
    </span>
  );
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "6px 0 10px", color: "var(--text-muted)" }}
      role="note"
    >
      {item("global", "queued", "Global — available to every project")}
      {item("project", "running", "Project — only this project")}
      {item("run", "passed", "Run-only — set at launch, not saved")}
    </div>
  );
}
