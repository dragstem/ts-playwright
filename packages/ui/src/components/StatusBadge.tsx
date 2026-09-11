// Status-semantic badge. `status` drives the color via [data-status] in tokens.css; the
// running status pulses. Accepts both RunStatus and the finer RunOutcome values.
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className="tsp-badge" data-status={status}>
      {label ?? status}
    </span>
  );
}
