import type { BrowserResult, BrowserStage, EdgeSummary, RunEvent } from '@returntrip/contracts';
import type { ArtifactRecord, RepairRecord, RunRecord, RunStore } from '@returntrip/storage';

export interface StageReport {
  readonly stage: BrowserStage;
  readonly outcome: BrowserResult['outcome'];
  readonly reasonCode: string | null;
  readonly oneLiner: string | null;
  readonly creditsUsed: number | null;
  readonly durationMs: number;
  readonly vendorDurationSec: number | null;
  readonly kaneVersion: string | null;
  readonly steps: readonly { readonly index: number; readonly status: string; readonly remark: string }[];
  readonly assertions: BrowserResult['assertions'];
  readonly evidenceVerdict: BrowserResult['evidenceVerdict'] | null;
}

export interface AttemptReport {
  readonly number: number;
  readonly kind: 'initial' | 'repair';
  readonly outcome: string | null;
  readonly destination: string | null;
  readonly patchSha256: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly stages: readonly StageReport[];
  readonly comparisons: readonly EdgeSummary[];
}

export interface ManifestEntry {
  readonly id: string;
  readonly attempt: number;
  readonly kind: ArtifactRecord['kind'];
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface RunReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly project: string;
  readonly mode: RunRecord['mode'];
  readonly outcome: RunRecord['outcome'];
  readonly headline: string | null;
  readonly failureCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly hashes: { readonly config: string; readonly contract: string; readonly source: string };
  readonly baseRevision: string | null;
  /** managed: ReturnTrip started a copy of the app. attached: a real, separately running app. */
  readonly target: { readonly mode: 'managed' | 'attached'; readonly origin: string | null } | null;
  readonly scenario: {
    readonly name: string;
    readonly disclosure: string;
    readonly reference: string | null;
  } | null;
  readonly kane: {
    readonly version: string | null;
    readonly creditsUsed: number;
    readonly creditsCap: number;
  };
  readonly agent: {
    readonly versions: readonly string[];
    readonly models: readonly string[];
    readonly usd: number;
  };
  readonly attempts: readonly AttemptReport[];
  readonly repairs: readonly RepairRecord[];
  readonly timeline: readonly { readonly utc: string; readonly elapsedMs: number; readonly text: string }[];
  readonly limitations: readonly string[];
  readonly manifest: readonly ManifestEntry[];
}

export const LIMITATIONS: readonly string[] = [
  'It proves the declared fields survive one CSV export, restore and re-export on a test copy of the app. It does not certify backups or fields outside the contract.',
  'Kane uploads the restore file to TestMu AI cloud storage before setting it on the file input. Use public or test data only.',
  'Kane drives the browser and reports its own pass or fail. ReturnTrip decides data equality with deterministic code and never trusts a browser success toast.',
  'Controlled defects are recreated on a demo app and labelled as such. They are not a blind benchmark.',
];

function stageReport(stage: BrowserStage, result: BrowserResult): StageReport {
  return {
    stage,
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    oneLiner: result.oneLiner,
    creditsUsed: result.creditsUsed,
    durationMs: result.durationMs,
    vendorDurationSec: result.vendorDurationSec,
    kaneVersion: result.version,
    steps: result.steps.map((step) => ({ index: step.index, status: step.status, remark: step.remark })),
    assertions: result.assertions,
    evidenceVerdict: result.evidenceVerdict ?? null,
  };
}

/** Turns stored events into the plain-language timeline shown in reports and the dashboard. */
export function describeEvent(event: RunEvent): string | null {
  switch (event.type) {
    case 'phase.changed':
      return event.payload.message;
    case 'browser.finished':
      return `Kane ${event.payload.stage}: ${event.payload.outcome}${event.payload.oneLiner ? `, ${event.payload.oneLiner}` : ''}`;
    case 'artifact.captured':
      return `Captured ${event.payload.kind} (${event.payload.byteLength} bytes, sha256 ${event.payload.sha256.slice(0, 12)})`;
    case 'comparison.completed':
      return `${event.payload.edge.replace('_', ' to ')}: ${event.payload.headline}`;
    case 'repair.patch':
      return `Patch ${event.payload.patchSha256.slice(0, 12)} changed ${event.payload.filesChanged.join(', ')}: ${event.payload.cause}`;
    case 'repair.rejected':
      return `Patch rejected: ${event.payload.reason}`;
    case 'build.finished':
      return event.payload.ok ? 'Rebuilt the patched app' : 'The patched app failed to build';
    case 'warning':
      return `Warning: ${event.payload.message}`;
    case 'run.finished':
      return `${event.payload.outcome}: ${event.payload.headline}`;
    default:
      return null;
  }
}

/** What the run was pointed at. Comes from the config, so the caller supplies it. */
export interface ReportContext {
  readonly scenario: RunReport['scenario'];
  readonly target: RunReport['target'];
}

export const NO_CONTEXT: ReportContext = { scenario: null, target: null };

export function buildRunReport(
  store: RunStore,
  runId: string,
  context: ReportContext = NO_CONTEXT,
): RunReport {
  const { scenario, target } = context;
  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const stages = store.listStages(runId);
  const comparisons = store.listComparisons(runId);
  const repairs = store.listRepairs(runId);
  const events = store.listEvents(runId);
  const attempts = store.listAttempts(runId).map(
    (attempt): AttemptReport => ({
      number: attempt.number,
      kind: attempt.kind,
      outcome: attempt.outcome,
      destination: attempt.destination,
      patchSha256: attempt.patchSha256,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      stages: stages.filter((s) => s.attempt === attempt.number).map((s) => stageReport(s.stage, s.result)),
      comparisons: comparisons.filter((c) => c.attempt === attempt.number).map((c) => c.summary),
    }),
  );
  const kaneVersions = stages.map((s) => s.result.version).filter((v): v is string => v !== null);
  return {
    schemaVersion: 1,
    runId: run.id,
    project: run.project,
    mode: run.mode,
    outcome: run.outcome,
    headline: run.headline,
    failureCode: run.failureCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
    hashes: { config: run.configHash, contract: run.contractHash, source: run.sourceHash },
    baseRevision: run.baseRevision,
    target,
    scenario,
    kane: {
      version: run.kaneVersion ?? kaneVersions[0] ?? null,
      creditsUsed: run.kaneCreditsUsed,
      creditsCap: run.budget.maxKaneCredits,
    },
    agent: {
      versions: [...new Set(repairs.map((r) => r.agentVersion).filter((v): v is string => v !== null))],
      models: [...new Set(repairs.flatMap((r) => r.models))].sort(),
      usd: run.agentUsd,
    },
    attempts,
    repairs,
    timeline: events.flatMap((event) => {
      const text = describeEvent(event);
      return text ? [{ utc: event.utc, elapsedMs: event.elapsedMs, text }] : [];
    }),
    limitations: LIMITATIONS,
    manifest: store.listArtifacts(runId).map((artifact) => ({
      id: artifact.id,
      attempt: artifact.attempt,
      kind: artifact.kind,
      path: artifact.relativePath,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mediaType: artifact.mediaType,
    })),
  };
}
