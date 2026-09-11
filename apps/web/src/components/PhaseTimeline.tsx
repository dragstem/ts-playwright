interface PhaseTiming {
  status: string;
  duration_ms: number | null;
}

// Horizontal run-phase timeline: each phase is a status-coloured badge, the active one pulses, and
// completed phases show their duration. Pure presentation, fed by the run SSE stream.
export function PhaseTimeline({
  phases,
  timings,
  currentPhase,
  isTerminal
}: {
  phases: string[];
  timings: Record<string, PhaseTiming>;
  currentPhase?: string;
  isTerminal: boolean;
}) {
  return (
    <div className="tsp-card" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {phases.map((phase) => {
        const timing = timings[phase];
        const active = currentPhase === phase && !isTerminal;
        const done = timing?.status === "done" || (isTerminal && phase === "done");
        const status = active ? "running" : done ? "passed" : "queued";
        return (
          <span key={phase} className="tsp-badge" data-status={status}>
            {phase}
            {timing?.duration_ms != null ? ` ${(timing.duration_ms / 1000).toFixed(1)}s` : ""}
          </span>
        );
      })}
    </div>
  );
}
