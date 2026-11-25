import { formatCount, plural } from './format.ts';
import type { AttemptReport, ComparisonEdge, EdgeSummary, RunReport } from './types.ts';

export const EDGES: readonly ComparisonEdge[] = ['source_reexport', 'source_export', 'export_reexport'];

export const EDGE_LABELS: Readonly<Record<ComparisonEdge, { expected: string; observed: string }>> = {
  source_export: { expected: 'Trusted source', observed: 'First export' },
  export_reexport: { expected: 'First export', observed: 'Export after restore' },
  source_reexport: { expected: 'Trusted source', observed: 'Export after restore' },
};

export function edgeTitle(edge: ComparisonEdge): string {
  const labels = EDGE_LABELS[edge];
  return `${labels.expected} vs ${labels.observed.toLowerCase()}`;
}

export function comparisonFor(attempt: AttemptReport | undefined, edge: ComparisonEdge): EdgeSummary | null {
  return attempt?.comparisons.find((summary) => summary.edge === edge) ?? null;
}

export interface RecordCounts {
  readonly source: number | null;
  readonly firstExport: number | null;
  readonly afterRestore: number | null;
  /** Rows identical to the trusted source after the full round trip. */
  readonly preserved: number | null;
  /** Rows that appeared in the restored export with no counterpart in the source. */
  readonly unexpected: number | null;
}

export function recordCounts(attempt: AttemptReport | undefined): RecordCounts {
  const sourceExport = comparisonFor(attempt, 'source_export');
  const sourceReexport = comparisonFor(attempt, 'source_reexport');
  const exportReexport = comparisonFor(attempt, 'export_reexport');
  return {
    source: sourceExport?.expectedRows ?? sourceReexport?.expectedRows ?? null,
    firstExport: sourceExport?.observedRows ?? exportReexport?.expectedRows ?? null,
    afterRestore: sourceReexport?.observedRows ?? exportReexport?.observedRows ?? null,
    preserved: sourceReexport?.matchedIdenticalOccurrences ?? null,
    unexpected: sourceReexport ? sourceReexport.unexpectedKeyCount + sourceReexport.excessOccurrences : null,
  };
}

/** Plain sentences built from a summary's own counts, for places with no stored headline. */
export function describeEdge(summary: EdgeSummary): string {
  const expected = formatCount(summary.expectedRows);
  if (summary.isEquivalent) return `${expected} of ${expected} records came back identical.`;
  const parts: string[] = [];
  for (const { field, rows } of summary.changedFields.slice(0, 2)) {
    parts.push(`the ${field} field changed in ${plural(rows, 'record')}`);
  }
  const missing = summary.missingKeyCount + summary.missingOccurrences;
  const extra = summary.unexpectedKeyCount + summary.excessOccurrences;
  if (missing > 0) parts.push(`${plural(missing, 'record')} missing`);
  if (extra > 0) parts.push(`${plural(extra, 'extra record')}`);
  if (summary.duplicateKeyCount > 0) parts.push(plural(summary.duplicateKeyCount, 'duplicated key'));
  if (summary.schemaErrorCount > 0) parts.push(plural(summary.schemaErrorCount, 'schema error'));
  const identical = `${formatCount(summary.matchedIdenticalOccurrences)} of ${expected} records came back identical.`;
  return parts.length > 0 ? `${identical} ${capitalize(parts.join(', '))}.` : identical;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function attemptLabel(attempt: AttemptReport): string {
  return attempt.kind === 'initial' ? `Attempt ${attempt.number}` : `Attempt ${attempt.number}, after repair`;
}

export function lastAttempt(report: RunReport): AttemptReport | undefined {
  return report.attempts.at(-1);
}

/**
 * The attempt the record inspector opens on: the first one where data broke, since that is the
 * evidence a reader came for, else the last one that reached a comparison.
 */
export function defaultAttempt(report: RunReport): AttemptReport | undefined {
  return (
    report.attempts.find((attempt) => attempt.comparisons.some((summary) => !summary.isEquivalent)) ??
    [...report.attempts].reverse().find((attempt) => attempt.comparisons.length > 0) ??
    lastAttempt(report)
  );
}

export function isDefectScenario(report: RunReport): boolean {
  return report.scenario !== null;
}
