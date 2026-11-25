import type { PublicIndexEntry } from './types.ts';

const DETECTED = new Set(['DATA_MISMATCH', 'REPAIRED_VERIFIED', 'REPAIR_UNRESOLVED']);

/** Runs against a real app ReturnTrip didn't start (attached mode), such as Sure. */
function isRealApp(run: PublicIndexEntry): boolean {
  return run.targetMode === 'attached';
}

export interface RecordedPicks {
  /** A healthy, unmodified run: the baseline the "how it works" numbers come from. */
  readonly healthy: PublicIndexEntry | null;
  /** A recreated defect that ReturnTrip caught, preferring one that was also repaired. */
  readonly defect: PublicIndexEntry | null;
  /** A real app where ReturnTrip caught data changing, when one was recorded. */
  readonly realApp: PublicIndexEntry | null;
}

export function pickRecordedRuns(runs: readonly PublicIndexEntry[]): RecordedPicks {
  const healthy =
    runs.find((run) => run.scenario === null && !isRealApp(run) && run.outcome === 'VERIFIED') ?? null;
  const caught = runs.filter(
    (run) => run.scenario !== null && run.outcome !== null && DETECTED.has(run.outcome),
  );
  const defect = caught.find((run) => run.outcome === 'REPAIRED_VERIFIED') ?? caught[0] ?? null;
  const realApp = runs.find((run) => isRealApp(run) && run.outcome === 'DATA_MISMATCH') ?? null;
  return { healthy, defect, realApp };
}

export interface RecordedTotals {
  readonly runs: number;
  readonly healthy: { readonly attempted: number; readonly verified: number };
  /** A miss is a recreated defect that came back VERIFIED: the check failed to see it. */
  readonly defects: { readonly attempted: number; readonly detected: number; readonly missed: number };
  readonly repairs: { readonly attempted: number; readonly verified: number };
  /** Runs against real, unmodified apps, and how many found the data changing. */
  readonly realApp: { readonly attempted: number; readonly caught: number };
  readonly kaneCredits: number;
  readonly durationMs: number;
}

export function recordedTotals(runs: readonly PublicIndexEntry[]): RecordedTotals {
  const healthyRuns = runs.filter((run) => run.scenario === null && !isRealApp(run));
  const realAppRuns = runs.filter(isRealApp);
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
    realApp: {
      attempted: realAppRuns.length,
      caught: realAppRuns.filter((run) => run.outcome === 'DATA_MISMATCH').length,
    },
    kaneCredits: runs.reduce((sum, run) => sum + run.kaneCreditsUsed, 0),
    durationMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
  };
}
