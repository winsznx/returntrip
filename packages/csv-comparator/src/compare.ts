import {
  type ArtifactSchemaError,
  type ComparisonEdge,
  type DataContract,
  EDGE_LABELS,
  type EdgeComparison,
  type EdgeSummary,
} from '@returntrip/contracts';
import { compareMultiset } from './compare-multiset.ts';
import { compareUniqueKey } from './compare-unique-key.ts';
import { type DraftDifference, finalizeDifferences } from './difference.ts';
import { canonicalContractHash } from './hash.ts';
import { createTally, type Tally } from './tally.ts';
import type { CompareOptions, ParsedArtifact } from './types.ts';

const ROW_SORT_WIDTH = 10;

/**
 * Compares one edge. Pure and deterministic: the same inputs always produce deep-equal output,
 * differences carry stable ids, and no tolerance or fuzzy matching is applied.
 */
export function compareArtifacts(
  expected: ParsedArtifact,
  observed: ParsedArtifact,
  contract: DataContract,
  edge: ComparisonEdge,
  options: CompareOptions = {},
): EdgeComparison {
  const contractHash = canonicalContractHash(contract);
  if (expected.contractHash !== contractHash || observed.contractHash !== contractHash) {
    throw new Error(`cannot compare ${edge}: artifacts were parsed against a different contract`);
  }
  const labels = EDGE_LABELS[edge];
  const tally = createTally();
  tally.drafts.push(
    ...schemaErrorDrafts(expected.schemaErrors, 'expected', labels.expected),
    ...schemaErrorDrafts(observed.schemaErrors, 'observed', labels.observed),
  );

  let comparable = expected.comparable && observed.comparable;
  if (comparable) {
    if (contract.identity.mode === 'multiset') {
      compareMultiset(expected, observed, contract, labels, options.pairResidualsByOrder ?? true, tally);
    } else {
      comparable = compareUniqueKey(expected, observed, contract, contract.identity.fields, labels, tally);
    }
  }

  const orderMismatch =
    comparable && contract.order === 'strict' && detectOrderChange(expected, observed, tally);
  const schemaErrorCount =
    expected.schemaErrors.length + observed.schemaErrors.length + tally.identityErrorCount;
  const differences = finalizeDifferences(edge, tally.drafts);
  const summary: EdgeSummary = {
    edge,
    isEquivalent: differences.length === 0 && schemaErrorCount === 0,
    expectedRows: expected.rowCount,
    observedRows: observed.rowCount,
    matchedIdenticalOccurrences: tally.matched,
    missingKeyCount: tally.missingKeyCount,
    unexpectedKeyCount: tally.unexpectedKeyCount,
    missingOccurrences: tally.missingOccurrences,
    excessOccurrences: tally.excessOccurrences,
    duplicateKeyCount: tally.duplicateKeyCount,
    changedKeyCount: tally.changedKeyCount,
    changedFieldCount: [...tally.changedFieldRows.values()].reduce((sum, rows) => sum + rows, 0),
    schemaErrorCount,
    orderMismatch,
    preservationRate: comparable && expected.rowCount > 0 ? tally.matched / expected.rowCount : null,
    changedFields: changedFieldsByImpact(tally, contract),
  };
  return { summary, differences };
}

/** Order is judged only once content agrees, so a reorder is never double-counted with content loss. */
function detectOrderChange(expected: ParsedArtifact, observed: ParsedArtifact, tally: Tally): boolean {
  const contentMatches =
    tally.matched === expected.rows.length &&
    expected.rows.length === observed.rows.length &&
    tally.drafts.every((draft) => draft.kind === 'SCHEMA_INVALID');
  if (!contentMatches) return false;
  const position = expected.rows.findIndex((row, index) => row.tupleKey !== observed.rows[index]?.tupleKey);
  if (position === -1) return false;
  const expectedRow = expected.rows[position];
  const observedRow = observed.rows[position];
  tally.drafts.push({
    kind: 'ORDER_CHANGED',
    identity: 'order',
    occurrence: 0,
    expectedRowRefs: expectedRow ? [expectedRow.rowNumber] : [],
    observedRowRefs: observedRow ? [observedRow.rowNumber] : [],
    message: `same rows in a different order; first divergence at position ${position + 1}`,
  });
  return true;
}

function schemaErrorDrafts(
  errors: readonly ArtifactSchemaError[],
  side: 'expected' | 'observed',
  label: string,
): DraftDifference[] {
  return errors.map((error, occurrence) => {
    const rowRefs = error.row === null ? [] : [error.row];
    const location = [error.row === null ? null : `row ${error.row}`, error.column]
      .filter(Boolean)
      .join(', ');
    return {
      kind: 'SCHEMA_INVALID',
      identity: `${side}:${error.row === null ? '' : String(error.row).padStart(ROW_SORT_WIDTH, '0')}`,
      occurrence,
      ...(error.column === null ? {} : { field: error.column }),
      expectedRowRefs: side === 'expected' ? rowRefs : [],
      observedRowRefs: side === 'observed' ? rowRefs : [],
      message: `${label}${location ? ` ${location}` : ''}: ${error.message}`,
    };
  });
}

function changedFieldsByImpact(tally: Tally, contract: DataContract): EdgeSummary['changedFields'] {
  const declaredOrder = new Map(contract.fields.map((field, index) => [field.name, index]));
  return [...tally.changedFieldRows]
    .map(([field, rows]) => ({ field, rows }))
    .sort((a, b) => b.rows - a.rows || (declaredOrder.get(a.field) ?? 0) - (declaredOrder.get(b.field) ?? 0));
}
