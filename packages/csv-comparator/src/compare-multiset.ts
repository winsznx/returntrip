import type { DataContract } from '@returntrip/contracts';
import { formatRowRefs, recordFieldChanges, type SideLabels, type Tally } from './tally.ts';
import type { CanonicalRow, ParsedArtifact } from './types.ts';

interface TupleGroup {
  readonly expected: CanonicalRow[];
  readonly observed: CanonicalRow[];
}

interface Residual {
  readonly row: CanonicalRow;
  /** Index of this occurrence among all rows sharing its tuple on its side. */
  readonly occurrence: number;
}

/**
 * Multiset identity (PRD 8.2): whole canonical tuples are grouped with counts and identical
 * occurrences cancel. What remains is either order-paired into field changes (see
 * `pairResidualsByOrder`) or reported as missing and excess occurrences per tuple.
 */
export function compareMultiset(
  expected: ParsedArtifact,
  observed: ParsedArtifact,
  contract: DataContract,
  labels: SideLabels,
  pairResidualsByOrder: boolean,
  tally: Tally,
): void {
  const groups = new Map<string, TupleGroup>();
  const groupFor = (tupleKey: string): TupleGroup => {
    let group = groups.get(tupleKey);
    if (!group) {
      group = { expected: [], observed: [] };
      groups.set(tupleKey, group);
    }
    return group;
  };
  for (const row of expected.rows) groupFor(row.tupleKey).expected.push(row);
  for (const row of observed.rows) groupFor(row.tupleKey).observed.push(row);

  const missing: Residual[] = [];
  const excess: Residual[] = [];
  for (const group of groups.values()) {
    const matched = Math.min(group.expected.length, group.observed.length);
    tally.matched += matched;
    for (const [index, row] of group.expected.slice(matched).entries()) {
      missing.push({ row, occurrence: matched + index });
    }
    for (const [index, row] of group.observed.slice(matched).entries()) {
      excess.push({ row, occurrence: matched + index });
    }
  }

  /*
   * Without a key there is no principled way to say which excess row "is" a missing one. The one
   * case where a reader expects pairing is an in-place edit: same row count, same residual count,
   * every row still where it was. Pairing by position then turns "1,000 missing + 1,000 excess"
   * into "amount changed on 1,000 rows". It is all-or-nothing and labelled in every message.
   */
  const canPair =
    pairResidualsByOrder &&
    missing.length > 0 &&
    missing.length === excess.length &&
    expected.rowCount === observed.rowCount;
  if (canPair) {
    const byRowNumber = (a: Residual, b: Residual): number => a.row.rowNumber - b.row.rowNumber;
    missing.sort(byRowNumber);
    excess.sort(byRowNumber);
    missing.forEach((expectedResidual, index) => {
      const observedResidual = excess[index];
      if (!observedResidual) return;
      tally.changedKeyCount++;
      recordFieldChanges(tally, contract, labels, expectedResidual.row, observedResidual.row, {
        identity: expectedResidual.row.tupleKey,
        occurrence: expectedResidual.occurrence,
        ordinal: expectedResidual.row.rowNumber,
        note: 'paired by row order',
      });
    });
    return;
  }

  for (const [tupleKey, group] of groups) {
    const expectedCount = group.expected.length;
    const observedCount = group.observed.length;
    if (expectedCount === observedCount) continue;
    const expectedRowRefs = group.expected.map((row) => row.rowNumber);
    const observedRowRefs = group.observed.map((row) => row.rowNumber);
    const counts =
      `appears ${times(expectedCount)} in ${labels.expected}` +
      `${expectedCount > 0 ? ` (${formatRowRefs(expectedRowRefs)})` : ''}` +
      ` and ${times(observedCount)} in ${labels.observed}` +
      `${observedCount > 0 ? ` (${formatRowRefs(observedRowRefs)})` : ''}`;
    if (expectedCount > observedCount) {
      tally.missingOccurrences += expectedCount - observedCount;
      tally.drafts.push({
        kind: 'MISSING_OCCURRENCE',
        identity: tupleKey,
        occurrence: 0,
        expectedCanonical: tupleKey,
        expectedCount,
        observedCount,
        expectedRowRefs,
        observedRowRefs,
        message: `row ${tupleKey} ${counts}`,
      });
    } else {
      tally.excessOccurrences += observedCount - expectedCount;
      tally.drafts.push({
        kind: 'EXCESS_OCCURRENCE',
        identity: tupleKey,
        occurrence: 0,
        observedCanonical: tupleKey,
        expectedCount,
        observedCount,
        expectedRowRefs,
        observedRowRefs,
        message: `row ${tupleKey} ${counts}`,
      });
    }
  }
}

function times(count: number): string {
  return count === 1 ? '1 time' : `${count} times`;
}
