import { useHealthStream } from "../lib/useHealthStream";

// Live backend health dot in the header (storage + Docker readiness over SSE). Green = ready,
// amber = a dependency is down, grey = the stream itself is offline.
export function HealthIndicator() {
  const health = useHealthStream(true);

  const { color, label, title } = resolve(health);
  return (
    <span
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}

function resolve(health: ReturnType<typeof useHealthStream>): { color: string; label: string; title: string } {
  if (!health.connected || health.ready === null) {
    return { color: "var(--status-queued)", label: "Health", title: "Health stream offline" };
  }
  if (health.ready) {
    return { color: "var(--status-passed)", label: "Healthy", title: "Storage and Docker are ready" };
  }
  const down = [
    health.checks.storage === false ? "storage" : null,
    health.checks.docker === false ? "Docker" : null
  ].filter(Boolean);
  return {
    color: "var(--status-timeout)",
    label: "Degraded",
    title: down.length ? `Not ready: ${down.join(", ")}` : "Backend not ready"
  };
}
