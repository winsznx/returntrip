import type { DataContract } from '@returntrip/contracts';
import type { DraftDifference } from './difference.ts';
import type { CanonicalRow } from './types.ts';

/** Mutable accumulator shared by the identity strategies while one edge is compared. */
export interface Tally {
  matched: number;
  missingKeyCount: number;
  unexpectedKeyCount: number;
  missingOccurrences: number;
  excessOccurrences: number;
  duplicateKeyCount: number;
  changedKeyCount: number;
  /** Identity defects found during comparison (null or duplicate keys); they count as schema errors. */
  identityErrorCount: number;
  readonly changedFieldRows: Map<string, number>;
  readonly drafts: DraftDifference[];
}

export interface SideLabels {
  readonly expected: string;
  readonly observed: string;
}

export function createTally(): Tally {
  return {
    matched: 0,
    missingKeyCount: 0,
    unexpectedKeyCount: 0,
    missingOccurrences: 0,
    excessOccurrences: 0,
    duplicateKeyCount: 0,
    changedKeyCount: 0,
    identityErrorCount: 0,
    changedFieldRows: new Map(),
    drafts: [],
  };
}

function formatCanonical(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

export function formatRowRefs(rows: readonly number[]): string {
  return rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.join(', ')}`;
}

/** Emits one FIELD_CHANGED per differing field of a row pair and counts the affected rows per field. */
export function recordFieldChanges(
  tally: Tally,
  contract: DataContract,
  labels: SideLabels,
  expected: CanonicalRow,
  observed: CanonicalRow,
  pairing: {
    readonly identity: string;
    readonly occurrence: number;
    readonly ordinal?: number;
    readonly key?: readonly string[];
    readonly note: string;
  },
): void {
  contract.fields.forEach((field, index) => {
    const before = expected.canonical[index] ?? null;
    const after = observed.canonical[index] ?? null;
    if (before === after) return;
    tally.changedFieldRows.set(field.name, (tally.changedFieldRows.get(field.name) ?? 0) + 1);
    tally.drafts.push({
      kind: 'FIELD_CHANGED',
      identity: pairing.identity,
      occurrence: pairing.occurrence,
      ...(pairing.ordinal === undefined ? {} : { ordinal: pairing.ordinal }),
      ...(pairing.key === undefined ? {} : { key: pairing.key }),
      field: field.name,
      expectedRaw: expected.raw[field.name] ?? null,
      observedRaw: observed.raw[field.name] ?? null,
      expectedCanonical: before,
      observedCanonical: after,
      expectedRowRefs: [expected.rowNumber],
      observedRowRefs: [observed.rowNumber],
      message:
        `${field.name} changed from ${formatCanonical(before)} to ${formatCanonical(after)} ` +
        `(${labels.expected} row ${expected.rowNumber}, ${labels.observed} row ${observed.rowNumber}, ${pairing.note})`,
    });
  });
}
