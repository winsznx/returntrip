import { api } from './api.ts';
import type {
  BrowserStage,
  ComparisonEdge,
  Difference,
  DifferenceKind,
  EdgeSummary,
  ManifestEntry,
  PublicIndex,
  PublicRun,
  RunReport,
} from './types.ts';

export interface FileRef {
  readonly kind: string;
  readonly attempt: number;
  readonly name: string;
  readonly href: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface Screenshot {
  readonly src: string;
  readonly step: string;
  /** 1-based position within the stage, matching the stage's step list order. */
  readonly position: number;
}

export interface DifferenceQuery {
  readonly attempt: number;
  readonly edge: ComparisonEdge;
  readonly kind?: DifferenceKind;
  readonly field?: string;
  readonly offset: number;
  readonly limit: number;
}

export interface DifferenceResult {
  readonly differences: readonly Difference[];
  /** How many differences match the query. */
  readonly total: number;
  /** Set when only a bounded sample is available, as in a published bundle. */
  readonly sample: { readonly size: number; readonly edgeTotal: number } | null;
}

/** One interface over a published bundle and the local API, so the run page is the same code. */
export interface EvidenceSource {
  readonly kind: 'recorded' | 'local';
  readonly runId: string;
  differences(query: DifferenceQuery, signal?: AbortSignal): Promise<DifferenceResult>;
  files(): readonly FileRef[];
  /** Screenshots for one try of a stage; tryIndex 0 is the first try. */
  screenshots(attempt: number, stage: BrowserStage, tryIndex: number): readonly Screenshot[];
  /** Kane evidence packs for a stage in run order; a retried stage has one per try. */
  evidencePacks(attempt: number, stage: BrowserStage): readonly FileRef[];
}

export function evidenceUrl(path: string): string {
  return `${import.meta.env.BASE_URL}evidence/${path}`;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  return (await response.json()) as T;
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  return response.text();
}

export function loadPublicIndex(signal?: AbortSignal): Promise<PublicIndex> {
  return fetchJson<PublicIndex>(evidenceUrl('index.json'), signal);
}

const RUN_ID = /^[0-9a-f-]{36}$/;

export function loadPublicRun(runId: string, signal?: AbortSignal): Promise<PublicRun> {
  if (!RUN_ID.test(runId)) return Promise.reject(new Error('That is not a run id.'));
  return fetchJson<PublicRun>(evidenceUrl(`${runId}/run.json`), signal);
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function recordedSource(run: PublicRun): EvidenceSource {
  const runId = run.report.runId;
  const files: FileRef[] = run.files.map((file) => ({
    kind: file.kind,
    attempt: file.attempt,
    name: fileName(file.file),
    href: evidenceUrl(`${runId}/${file.file}`),
    sha256: file.sha256,
    byteLength: file.byteLength,
  }));
  return {
    kind: 'recorded',
    runId,
    async differences(query) {
      const edgeData = run.differences[String(query.attempt)]?.[query.edge];
      const items = edgeData?.items ?? [];
      const filtered = items.filter(
        (item) => (!query.kind || item.kind === query.kind) && (!query.field || item.field === query.field),
      );
      const filteredOut = filtered.length !== items.length;
      return {
        differences: filtered.slice(query.offset, query.offset + query.limit),
        total: filteredOut ? filtered.length : (edgeData?.total ?? 0),
        sample:
          edgeData && edgeData.items.length < edgeData.total
            ? { size: edgeData.items.length, edgeTotal: edgeData.total }
            : null,
      };
    },
    files: () => files,
    screenshots(attempt, stage, tryIndex) {
      return run.screenshots
        .filter((shot) => shot.attempt === attempt && shot.stage === stage && (shot.try ?? 0) === tryIndex)
        .map((shot, index) => ({
          src: evidenceUrl(`${runId}/${shot.file}`),
          step: shot.step,
          position: index + 1,
        }));
    },
    evidencePacks: () => [],
  };
}

/** "export.evidence.zip" is try 0, "export-retry1.evidence.zip" try 1; other stages give null. */
export function packTryIndex(name: string, stage: BrowserStage): number | null {
  const match = /^([a-z-]+?)(?:-retry(\d+))?\.evidence\.zip$/.exec(name);
  if (!match || match[1] !== stage) return null;
  return match[2] ? Number(match[2]) : 0;
}

const LOCAL_FILE_KINDS = new Set(['source', 'export', 'reexport', 'restore-upload', 'patch']);

function localRef(runId: string, entry: ManifestEntry): FileRef {
  return {
    kind: entry.kind,
    attempt: entry.attempt,
    name: fileName(entry.path),
    href: api.artifactUrl(runId, entry.id),
    sha256: entry.sha256,
    byteLength: entry.byteLength,
  };
}

export function localSource(report: RunReport): EvidenceSource {
  const runId = report.runId;
  const files = report.manifest
    .filter((entry) => LOCAL_FILE_KINDS.has(entry.kind))
    .map((entry) => localRef(runId, entry));
  return {
    kind: 'local',
    runId,
    async differences(query, signal) {
      const page = await api.differences(
        runId,
        {
          attempt: query.attempt,
          edge: query.edge,
          offset: query.offset,
          limit: query.limit,
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.field ? { field: query.field } : {}),
        },
        signal,
      );
      return { differences: page.differences, total: page.total, sample: null };
    },
    files: () => files,
    screenshots: () => [],
    evidencePacks(attempt, stage) {
      return report.manifest
        .filter((item) => item.kind === 'evidence-pack' && item.attempt === attempt)
        .flatMap((entry) => {
          const tryIndex = packTryIndex(fileName(entry.path), stage);
          return tryIndex === null ? [] : [{ tryIndex, ref: localRef(runId, entry) }];
        })
        .sort((a, b) => a.tryIndex - b.tryIndex)
        .map(({ ref }) => ref);
    },
  };
}

export function findFile(source: EvidenceSource, kind: string, attempt?: number): FileRef | null {
  return (
    source
      .files()
      .find((file) => file.kind === kind && (attempt === undefined || file.attempt === attempt)) ?? null
  );
}

/** Which kinds the summary says exist, so filters never offer an empty category. */
export function kindsPresent(summary: EdgeSummary | null): DifferenceKind[] {
  if (!summary) return [];
  const counts: [DifferenceKind, number][] = [
    ['FIELD_CHANGED', summary.changedFieldCount],
    ['MISSING_KEY', summary.missingKeyCount],
    ['UNEXPECTED_KEY', summary.unexpectedKeyCount],
    ['MISSING_OCCURRENCE', summary.missingOccurrences],
    ['EXCESS_OCCURRENCE', summary.excessOccurrences],
    ['DUPLICATE_KEY', summary.duplicateKeyCount],
    ['SCHEMA_INVALID', summary.schemaErrorCount],
    ['ORDER_CHANGED', summary.orderMismatch ? 1 : 0],
  ];
  return counts.filter(([, count]) => count > 0).map(([kind]) => kind);
}

export const KIND_LABELS: Readonly<Record<DifferenceKind, string>> = {
  FIELD_CHANGED: 'Field changed',
  MISSING_KEY: 'Missing record',
  UNEXPECTED_KEY: 'Unexpected record',
  MISSING_OCCURRENCE: 'Missing copy',
  EXCESS_OCCURRENCE: 'Extra copy',
  DUPLICATE_KEY: 'Duplicated key',
  SCHEMA_INVALID: 'Schema error',
  ORDER_CHANGED: 'Order changed',
};

/** Which artifact each side of an edge reads from, for loading the full rows behind row refs. */
export function edgeArtifacts(
  edge: ComparisonEdge,
  attempt: number,
): { expected: { kind: string; attempt: number }; observed: { kind: string; attempt: number } } {
  switch (edge) {
    case 'source_export':
      return { expected: { kind: 'source', attempt: 0 }, observed: { kind: 'export', attempt } };
    case 'export_reexport':
      return { expected: { kind: 'export', attempt }, observed: { kind: 'reexport', attempt } };
    default:
      return { expected: { kind: 'source', attempt: 0 }, observed: { kind: 'reexport', attempt } };
  }
}
