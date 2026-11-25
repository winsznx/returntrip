import type { DataContract } from '@returntrip/contracts';
import type { DraftDifference } from './difference.ts';
import { formatRowRefs, recordFieldChanges, type SideLabels, type Tally } from './tally.ts';
import type { CanonicalRow, ParsedArtifact } from './types.ts';

interface KeyedRows {
  readonly byKey: Map<string, { readonly key: readonly string[]; readonly rows: CanonicalRow[] }>;
  /** Rows whose identity has a null component; they can never be matched. */
  readonly nullKeyRows: readonly CanonicalRow[];
}

export function keyFieldIndexes(contract: DataContract, keyFields: readonly string[]): number[] {
  return keyFields.map((name) => {
    const index = contract.fields.findIndex((field) => field.name === name);
    if (index === -1)
      throw new Error(`identity field "${name}" is not declared; validate the contract first`);
    return index;
  });
}

function indexRows(artifact: ParsedArtifact, keyIndexes: readonly number[]): KeyedRows {
  const byKey: KeyedRows['byKey'] = new Map();
  const nullKeyRows: CanonicalRow[] = [];
  for (const row of artifact.rows) {
    const key: string[] = [];
    for (const index of keyIndexes) {
      const value = row.canonical[index];
      if (value === null || value === undefined) break;
      key.push(value);
    }
    if (key.length !== keyIndexes.length) {
      nullKeyRows.push(row);
      continue;
    }
    const identity = JSON.stringify(key);
    const entry = byKey.get(identity);
    if (entry) entry.rows.push(row);
    else byKey.set(identity, { key, rows: [row] });
  }
  return { byKey, nullKeyRows };
}

/**
 * Identity defects in the trusted side of an edge (PRD 8.2): a null or repeated key means the
 * baseline cannot say what the observed artifact should contain.
 */
export function baselineIdentityDefects(
  expected: ParsedArtifact,
  keyIndexes: readonly number[],
  label: string,
): DraftDifference[] {
  return identityDefects(indexRows(expected, keyIndexes), 'expected', label);
}

function identityDefects(keyed: KeyedRows, side: 'expected' | 'observed', label: string): DraftDifference[] {
  const drafts: DraftDifference[] = keyed.nullKeyRows.map((row, occurrence) => ({
    kind: 'SCHEMA_INVALID',
    identity: `${side}:identity`,
    occurrence,
    ordinal: row.rowNumber,
    expectedRowRefs: side === 'expected' ? [row.rowNumber] : [],
    observedRowRefs: side === 'observed' ? [row.rowNumber] : [],
    message: `${label} row ${row.rowNumber} has a null identity field`,
  }));
  if (side === 'expected') {
    for (const [identity, entry] of keyed.byKey) {
      if (entry.rows.length < 2) continue;
      const rowRefs = entry.rows.map((row) => row.rowNumber);
      drafts.push({
        kind: 'SCHEMA_INVALID',
        identity: `${side}:${identity}`,
        occurrence: 0,
        key: entry.key,
        expectedCount: entry.rows.length,
        expectedRowRefs: rowRefs,
        observedRowRefs: [],
        message: `key ${identity} is repeated in ${label} (${formatRowRefs(rowRefs)}); the baseline is invalid`,
      });
    }
  }
  return drafts;
}

/**
 * Unique-key identity (PRD 8.2). Returns false when the baseline's identities are defective, in
 * which case nothing is matched and only the defects are reported.
 */
export function compareUniqueKey(
  expected: ParsedArtifact,
  observed: ParsedArtifact,
  contract: DataContract,
  keyFields: readonly string[],
  labels: SideLabels,
  tally: Tally,
): boolean {
  const keyIndexes = keyFieldIndexes(contract, keyFields);
  const expectedKeyed = indexRows(expected, keyIndexes);
  const baselineDefects = identityDefects(expectedKeyed, 'expected', labels.expected);
  if (baselineDefects.length > 0) {
    tally.identityErrorCount += baselineDefects.length;
    tally.drafts.push(...baselineDefects);
    return false;
  }

  const observedKeyed = indexRows(observed, keyIndexes);
  const observedDefects = identityDefects(observedKeyed, 'observed', labels.observed);
  tally.identityErrorCount += observedDefects.length;
  tally.drafts.push(...observedDefects);

  for (const [identity, { key, rows }] of expectedKeyed.byKey) {
    const expectedRow = rows[0];
    if (!expectedRow) continue;
    const observedRows = observedKeyed.byKey.get(identity)?.rows ?? [];
    const observedRowRefs = observedRows.map((row) => row.rowNumber);

    if (observedRows.length === 0) {
      tally.missingKeyCount++;
      tally.missingOccurrences++;
      tally.drafts.push({
        kind: 'MISSING_KEY',
        identity,
        occurrence: 0,
        key,
        expectedCount: 1,
        observedCount: 0,
        expectedRowRefs: [expectedRow.rowNumber],
        observedRowRefs: [],
        message: `key ${identity} (${labels.expected} row ${expectedRow.rowNumber}) is missing from ${labels.observed}`,
      });
      continue;
    }

    const [onlyObserved] = observedRows;
    if (observedRows.length === 1 && onlyObserved) {
      if (onlyObserved.tupleKey === expectedRow.tupleKey) {
        tally.matched++;
      } else {
        tally.changedKeyCount++;
        recordFieldChanges(tally, contract, labels, expectedRow, onlyObserved, {
          identity,
          occurrence: 0,
          key,
          note: `key ${identity}`,
        });
      }
      continue;
    }

    // An exact copy is matched first; with none, no copy is promoted to "the" record.
    const hasExactCopy = observedRows.some((row) => row.tupleKey === expectedRow.tupleKey);
    tally.duplicateKeyCount++;
    if (hasExactCopy) {
      tally.matched++;
      tally.excessOccurrences += observedRows.length - 1;
    } else {
      tally.missingOccurrences++;
      tally.excessOccurrences += observedRows.length;
    }
    tally.drafts.push({
      kind: 'DUPLICATE_KEY',
      identity,
      occurrence: 0,
      key,
      expectedCount: 1,
      observedCount: observedRows.length,
      expectedRowRefs: [expectedRow.rowNumber],
      observedRowRefs,
      message:
        `key ${identity} appears ${observedRows.length} times in ${labels.observed} (${formatRowRefs(observedRowRefs)}); ` +
        (hasExactCopy ? 'one copy matches exactly' : 'no copy matches exactly'),
    });
  }

  for (const [identity, { key, rows }] of observedKeyed.byKey) {
    if (expectedKeyed.byKey.has(identity)) continue;
    const observedRowRefs = rows.map((row) => row.rowNumber);
    tally.unexpectedKeyCount++;
    tally.excessOccurrences += rows.length;
    tally.drafts.push({
      kind: 'UNEXPECTED_KEY',
      identity,
      occurrence: 0,
      key,
      expectedCount: 0,
      observedCount: rows.length,
      expectedRowRefs: [],
      observedRowRefs,
      message: `key ${identity} is in ${labels.observed} (${formatRowRefs(observedRowRefs)}) but not in ${labels.expected}`,
    });
    if (rows.length > 1) {
      tally.duplicateKeyCount++;
      tally.drafts.push({
        kind: 'DUPLICATE_KEY',
        identity,
        occurrence: 0,
        key,
        expectedCount: 0,
        observedCount: rows.length,
        expectedRowRefs: [],
        observedRowRefs,
        message: `key ${identity} appears ${rows.length} times in ${labels.observed} (${formatRowRefs(observedRowRefs)})`,
      });
    }
  }
  return true;
}
