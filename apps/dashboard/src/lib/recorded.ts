import type { PublicIndexEntry } from './types.ts';

const DETECTED = new Set(['DATA_MISMATCH', 'REPAIRED_VERIFIED', 'REPAIR_UNRESOLVED']);

export interface RecordedPicks {
  /** A healthy, unmodified run: the baseline the "how it works" numbers come from. */
  readonly healthy: PublicIndexEntry | null;
  /** A recreated defect that ReturnTrip caught, preferring one that was also repaired. */
  readonly defect: PublicIndexEntry | null;
}

export function pickRecordedRuns(runs: readonly PublicIndexEntry[]): RecordedPicks {
  const healthy = runs.find((run) => run.scenario === null && run.outcome === 'VERIFIED') ?? null;
  const caught = runs.filter(
    (run) => run.scenario !== null && run.outcome !== null && DETECTED.has(run.outcome),
  );
  const defect = caught.find((run) => run.outcome === 'REPAIRED_VERIFIED') ?? caught[0] ?? null;
  return { healthy, defect };
}

export interface RecordedTotals {
  readonly runs: number;
  readonly healthy: { readonly attempted: number; readonly verified: number };
  /** A miss is a recreated defect that came back VERIFIED: the check failed to see it. */
  readonly defects: { readonly attempted: number; readonly detected: number; readonly missed: number };
  readonly repairs: { readonly attempted: number; readonly verified: number };
  readonly kaneCredits: number;
  readonly durationMs: number;
}

export function recordedTotals(runs: readonly PublicIndexEntry[]): RecordedTotals {
  const healthyRuns = runs.filter((run) => run.scenario === null);
  const defectRuns = runs.filter((run) => run.scenario !== null);
  const repairRuns = runs.filter((run) => run.mode === 'repair');
  return {
    runs: runs.length,
    healthy: {
      attempted: healthyRuns.length,
      verified: healthyRuns.filter((run) => run.outcome === 'VERIFIED').length,
    },
    defects: {
      attempted: defectRuns.length,
      detected: defectRuns.filter((run) => run.outcome !== null && DETECTED.has(run.outcome)).length,
      missed: defectRuns.filter((run) => run.outcome === 'VERIFIED').length,
    },
    repairs: {
      attempted: repairRuns.length,
      verified: repairRuns.filter((run) => run.outcome === 'REPAIRED_VERIFIED').length,
    },
    kaneCredits: runs.reduce((sum, run) => sum + run.kaneCreditsUsed, 0),
    durationMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
  };
}
