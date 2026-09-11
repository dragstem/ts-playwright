import type { AppState, RunOutcome, RunRecord, RunStatus } from "@ts-playwright/shared";

// Phase 3 (2-R11) — batch aggregate for the batch screen + /api/batches[/:id]. A batch is the set
// of runs sharing a batch_id (created by a repeated single-scenario run or a folder/stage run).
// Pure over AppState so it is unit-testable without a server.

export type BatchAggregateStatus = "running" | "passed" | "failed" | "partial";

export interface BatchRunSummary {
  id: string;
  scenario_id: string;
  scenario_name: string | null;
  status: RunStatus;
  outcome: RunOutcome | null;
  execution_stage: number;
  run_iteration: number;
  amount_times_to_run: number;
  triggered_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BatchSummary {
  batch_id: string;
  project_id: string | null;
  total: number;
  done: number;
  in_progress: boolean;
  status: BatchAggregateStatus;
  counts: Record<RunStatus, number>;
  outcomes: Partial<Record<RunOutcome, number>>;
  scenario_ids: string[];
  stages: number[];
  triggered_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  runs: BatchRunSummary[];
}

const TERMINAL_STATUSES = new Set<RunStatus>(["passed", "failed", "error"]);

function emptyStatusCounts(): Record<RunStatus, number> {
  return { queued: 0, running: 0, passed: 0, failed: 0, error: 0 };
}

function minDate(left: string | null, right: string | null | undefined): string | null {
  const candidate = right ?? null;
  if (!candidate) {
    return left;
  }
  if (!left) {
    return candidate;
  }
  return candidate < left ? candidate : left;
}

function maxDate(left: string | null, right: string | null | undefined): string | null {
  const candidate = right ?? null;
  if (!candidate) {
    return left;
  }
  if (!left) {
    return candidate;
  }
  return candidate > left ? candidate : left;
}

function aggregateStatus(counts: Record<RunStatus, number>, inProgress: boolean): BatchAggregateStatus {
  if (inProgress) {
    return "running";
  }
  const failures = counts.failed + counts.error;
  if (failures === 0) {
    return "passed";
  }
  if (counts.passed === 0) {
    return "failed";
  }
  return "partial";
}

function summarizeRuns(batchId: string, runs: RunRecord[], state: AppState): BatchSummary {
  const counts = emptyStatusCounts();
  const outcomes: Partial<Record<RunOutcome, number>> = {};
  const scenarioIds = new Set<string>();
  const stages = new Set<number>();
  let projectId: string | null = null;
  let done = 0;
  let inProgress = false;
  let triggeredAt: string | null = null;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  let allFinished = true;

  for (const run of runs) {
    counts[run.status] += 1;
    if (run.outcome) {
      outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
    }
    scenarioIds.add(run.scenario_id);
    stages.add(run.execution_stage);
    if (projectId === null) {
      projectId = state.scenarios.find((item) => item.id === run.scenario_id)?.project_id ?? null;
    }
    if (TERMINAL_STATUSES.has(run.status)) {
      done += 1;
    } else {
      inProgress = true;
    }
    triggeredAt = minDate(triggeredAt, run.triggered_at);
    startedAt = minDate(startedAt, run.started_at);
    if (run.finished_at) {
      finishedAt = maxDate(finishedAt, run.finished_at);
    } else {
      allFinished = false;
    }
  }

  const scenarioNames = new Map(state.scenarios.map((scenario) => [scenario.id, scenario.name]));
  const runSummaries: BatchRunSummary[] = runs
    .slice()
    .sort(
      (left, right) =>
        left.execution_stage - right.execution_stage ||
        left.run_iteration - right.run_iteration ||
        left.id.localeCompare(right.id)
    )
    .map((run) => ({
      id: run.id,
      scenario_id: run.scenario_id,
      scenario_name: scenarioNames.get(run.scenario_id) ?? null,
      status: run.status,
      outcome: run.outcome ?? null,
      execution_stage: run.execution_stage,
      run_iteration: run.run_iteration,
      amount_times_to_run: run.amount_times_to_run,
      triggered_at: run.triggered_at,
      started_at: run.started_at ?? null,
      finished_at: run.finished_at ?? null
    }));

  return {
    batch_id: batchId,
    project_id: projectId,
    total: runs.length,
    done,
    in_progress: inProgress,
    status: aggregateStatus(counts, inProgress),
    counts,
    outcomes,
    scenario_ids: Array.from(scenarioIds),
    stages: Array.from(stages).sort((left, right) => left - right),
    triggered_at: triggeredAt,
    started_at: startedAt,
    finished_at: allFinished ? finishedAt : null,
    runs: runSummaries
  };
}

export function summarizeBatch(state: AppState, batchId: string): BatchSummary | null {
  const runs = state.runs.filter((run) => run.batch_id === batchId);
  if (runs.length === 0) {
    return null;
  }
  return summarizeRuns(batchId, runs, state);
}

export function summarizeBatches(state: AppState, limit?: number): BatchSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const run of state.runs) {
    if (!run.batch_id) {
      continue;
    }
    const group = groups.get(run.batch_id) ?? [];
    group.push(run);
    groups.set(run.batch_id, group);
  }
  const summaries = Array.from(groups.entries()).map(([batchId, runs]) => summarizeRuns(batchId, runs, state));
  // Most recently triggered batch first.
  summaries.sort((left, right) => String(right.triggered_at ?? "").localeCompare(String(left.triggered_at ?? "")));
  return typeof limit === "number" ? summaries.slice(0, limit) : summaries;
}
