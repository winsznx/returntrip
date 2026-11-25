import type { ComparisonEdge, DataContract, EdgeComparison } from '@returntrip/contracts';
import { describe, expect, it } from 'vitest';
import { type CompareOptions, compareArtifacts } from '../src/index.ts';
import {
  KEYED_LEDGER_CONTRACT,
  LEDGER_CONTRACT,
  makeContract,
  PAYMENTS_CONTRACT,
  parseText,
} from './helpers.ts';

function compareCsv(
  expectedCsv: string,
  observedCsv: string,
  contract: DataContract = LEDGER_CONTRACT,
  options: CompareOptions = {},
  edge: ComparisonEdge = 'source_export',
): EdgeComparison {
  return compareArtifacts(
    parseText(expectedCsv, contract, 'source'),
    parseText(observedCsv, contract, 'export'),
    contract,
    edge,
    options,
  );
}

const LEDGER = 'id,amount\nA,10.00\nB,20.50\nC,30\n';

describe('compareArtifacts: equivalence', () => {
  it('treats reordered rows, CRLF and a BOM as equivalent even though the raw hashes differ', () => {
    // #given the same data with different order, terminators and a byte order mark
    const reshaped = '﻿id,amount\r\nC,30.00\r\nA,10\r\nB,20.5\r\n';
    const source = parseText(LEDGER, LEDGER_CONTRACT, 'source');
    const exported = parseText(reshaped, LEDGER_CONTRACT, 'export');

    // #when
    const result = compareArtifacts(source, exported, LEDGER_CONTRACT, 'source_export');

    // #then
    expect({
      hashesDiffer: source.sha256 !== exported.sha256,
      isEquivalent: result.summary.isEquivalent,
      preservationRate: result.summary.preservationRate,
      differences: result.differences,
    }).toEqual({ hashesDiffer: true, isEquivalent: true, preservationRate: 1, differences: [] });
  });

  it('treats 1.2 and 1.20 at scale 2 as the same value', () => {
    // #given
    const expected = 'id,amount\nA,1.2\n';

    // #when
    const result = compareCsv(expected, 'id,amount\nA,1.20\n');

    // #then
    expect(result.summary.isEquivalent).toBe(true);
  });

  it('treats a header column reorder as equivalent', () => {
    // #given
    const reordered = 'amount,id\n10,A\n20.5,B\n30,C\n';

    // #when
    const result = compareCsv(LEDGER, reordered);

    // #then
    expect(result.summary.isEquivalent).toBe(true);
  });

  it('reports empty to empty as equivalent with no preservation rate', () => {
    // #given two header-only artifacts
    const empty = 'id,amount\n';

    // #when
    const result = compareCsv(empty, empty);

    // #then
    expect({
      isEquivalent: result.summary.isEquivalent,
      expectedRows: result.summary.expectedRows,
      preservationRate: result.summary.preservationRate,
    }).toEqual({ isEquivalent: true, expectedRows: 0, preservationRate: null });
  });
});

describe('compareArtifacts: multiset occurrences', () => {
  it('reports a missing row with its count and row reference', () => {
    // #given B is dropped and the row counts differ, so nothing is paired
    const observed = 'id,amount\nA,10\nC,30\n';

    // #when
    const result = compareCsv(LEDGER, observed);

    // #then
    expect(
      result.differences.map((d) => ({
        kind: d.kind,
        expectedCanonical: d.expectedCanonical,
        expectedCount: d.expectedCount,
        observedCount: d.observedCount,
        expectedRowRefs: d.expectedRowRefs,
      })),
    ).toEqual([
      {
        kind: 'MISSING_OCCURRENCE',
        expectedCanonical: '["B","20.50"]',
        expectedCount: 1,
        observedCount: 0,
        expectedRowRefs: [2],
      },
    ]);
  });

  it('counts missing occurrences against a preservation rate below 1', () => {
    // #given
    const observed = 'id,amount\nA,10\nC,30\n';

    // #when
    const { summary } = compareCsv(LEDGER, observed);

    // #then
    expect({
      matched: summary.matchedIdenticalOccurrences,
      missing: summary.missingOccurrences,
      excess: summary.excessOccurrences,
      rate: summary.preservationRate,
      isEquivalent: summary.isEquivalent,
    }).toEqual({ matched: 2, missing: 1, excess: 0, rate: 2 / 3, isEquivalent: false });
  });

  it('reports an extra row and keeps a 100% preservation rate, yet is not equivalent', () => {
    // #given
    const observed = `${LEDGER}D,40\n`;

    // #when
    const { summary } = compareCsv(LEDGER, observed);

    // #then
    expect({
      excess: summary.excessOccurrences,
      rate: summary.preservationRate,
      isEquivalent: summary.isEquivalent,
    }).toEqual({ excess: 1, rate: 1, isEquivalent: false });
  });

  it('preserves legitimate identical duplicate rows', () => {
    // #given two fully identical rows on both sides
    const withDuplicates = 'id,amount\nA,10\nA,10\nB,5\n';

    // #when
    const result = compareCsv(withDuplicates, 'id,amount\nB,5\nA,10.00\nA,10\n');

    // #then
    expect({
      isEquivalent: result.summary.isEquivalent,
      matched: result.summary.matchedIdenticalOccurrences,
    }).toEqual({ isEquivalent: true, matched: 3 });
  });

  it('detects a dropped copy of a duplicated row', () => {
    // #given one of two identical rows is lost
    const withDuplicates = 'id,amount\nA,10\nA,10\nB,5\n';

    // #when
    const result = compareCsv(withDuplicates, 'id,amount\nA,10\nB,5\n');

    // #then
    expect(
      result.differences.map((d) => [
        d.kind,
        d.expectedCount,
        d.observedCount,
        d.expectedRowRefs,
        d.observedRowRefs,
      ]),
    ).toEqual([['MISSING_OCCURRENCE', 2, 1, [1, 2], [1]]]);
  });

  it('reports pure missing and excess occurrences when order pairing is disabled', () => {
    // #given one amount edited in place
    const observed = 'id,amount\nA,10\nB,20.49\nC,30\n';

    // #when
    const result = compareCsv(LEDGER, observed, LEDGER_CONTRACT, { pairResidualsByOrder: false });

    // #then
    expect(result.differences.map((d) => d.kind)).toEqual(['MISSING_OCCURRENCE', 'EXCESS_OCCURRENCE']);
  });

  it('does not pair residuals when the artifacts have different row counts', () => {
    // #given one amount changed and one row added
    const observed = 'id,amount\nA,10\nB,20.49\nC,30\nD,1\n';

    // #when
    const result = compareCsv(LEDGER, observed);

    // #then
    expect(result.differences.map((d) => d.kind).sort()).toEqual([
      'EXCESS_OCCURRENCE',
      'EXCESS_OCCURRENCE',
      'MISSING_OCCURRENCE',
    ]);
  });
});

describe('compareArtifacts: multiset pairing by row order', () => {
  it('detects 1234.56 becoming 1234.00 exactly', () => {
    // #given
    const expected = 'id,amount\nA,1234.56\n';

    // #when
    const result = compareCsv(expected, 'id,amount\nA,1234.00\n');

    // #then
    expect(
      result.differences.map((d) => ({
        kind: d.kind,
        field: d.field,
        expectedRaw: d.expectedRaw,
        observedRaw: d.observedRaw,
        expectedCanonical: d.expectedCanonical,
        observedCanonical: d.observedCanonical,
      })),
    ).toEqual([
      {
        kind: 'FIELD_CHANGED',
        field: 'amount',
        expectedRaw: '1234.56',
        observedRaw: '1234.00',
        expectedCanonical: '1234.56',
        observedCanonical: '1234.00',
      },
    ]);
  });

  it('reports a sign flip on every row as FIELD_CHANGED on amount for every row', () => {
    // #given payments with fully identical duplicate rows and every amount negated
    const header = 'voucher_number,amount,check_date,department_name,contract_number,vendor_name';
    const rows = [
      ',17104.23,2009,,19120,POLISH/AMERICAN ASSOCIATION',
      'PVRF212205404,19038,03/02/2022,,DV,TABATHA PURDIS',
      'PVRF212205404,19038,03/02/2022,,DV,TABATHA PURDIS',
      'PV27232762143,70,07/03/2023,,DV,"TURKMANI, MAHAMMD T"',
    ];
    const flipped = rows.map((row) => row.replace(/,(\d)/, ',-$1'));
    const source = `${header}\n${rows.join('\n')}\n`;
    const exported = `${header}\n${flipped.join('\n')}\n`;

    // #when
    const result = compareCsv(source, exported, PAYMENTS_CONTRACT);

    // #then
    expect(
      result.differences.map((d) => [
        d.kind,
        d.field,
        d.expectedRaw,
        d.observedRaw,
        d.expectedRowRefs,
        d.observedRowRefs,
      ]),
    ).toEqual([
      ['FIELD_CHANGED', 'amount', '17104.23', '-17104.23', [1], [1]],
      ['FIELD_CHANGED', 'amount', '19038', '-19038', [2], [2]],
      ['FIELD_CHANGED', 'amount', '19038', '-19038', [3], [3]],
      ['FIELD_CHANGED', 'amount', '70', '-70', [4], [4]],
    ]);
  });

  it('summarizes a sign flip as changed rows, not as missing and excess', () => {
    // #given
    const observed = 'id,amount\nA,-10\nB,-20.50\nC,-30\n';

    // #when
    const { summary } = compareCsv(LEDGER, observed);

    // #then
    expect({
      matched: summary.matchedIdenticalOccurrences,
      missing: summary.missingOccurrences,
      excess: summary.excessOccurrences,
      changedKeyCount: summary.changedKeyCount,
      changedFieldCount: summary.changedFieldCount,
      changedFields: summary.changedFields,
      rate: summary.preservationRate,
    }).toEqual({
      matched: 0,
      missing: 0,
      excess: 0,
      changedKeyCount: 3,
      changedFieldCount: 3,
      changedFields: [{ field: 'amount', rows: 3 }],
      rate: 0,
    });
  });

  it('labels every paired change as paired by row order', () => {
    // #given
    const observed = 'id,amount\nA,10\nB,20.49\nC,30\n';

    // #when
    const result = compareCsv(LEDGER, observed);

    // #then
    expect(result.differences.map((d) => d.message)).toEqual([
      'amount changed from "20.50" to "20.49" (trusted source row 2, first export row 2, paired by row order)',
    ]);
  });
});

describe('compareArtifacts: unique key', () => {
  it('reports a changed key as missing plus unexpected, never as a rename', () => {
    // #given key B became Z with the same amount
    const observed = 'id,amount\nA,10\nZ,20.50\nC,30\n';

    // #when
    const result = compareCsv(LEDGER, observed, KEYED_LEDGER_CONTRACT);

    // #then
    expect({
      differences: result.differences.map((d) => [d.kind, d.key]),
      missingKeyCount: result.summary.missingKeyCount,
      unexpectedKeyCount: result.summary.unexpectedKeyCount,
      changedKeyCount: result.summary.changedKeyCount,
    }).toEqual({
      differences: [
        ['MISSING_KEY', ['B']],
        ['UNEXPECTED_KEY', ['Z']],
      ],
      missingKeyCount: 1,
      unexpectedKeyCount: 1,
      changedKeyCount: 0,
    });
  });

  it('reports a changed value under the same key as FIELD_CHANGED without missing or excess', () => {
    // #given
    const observed = 'id,amount\nC,30\nB,20.49\nA,10\n';

    // #when
    const result = compareCsv(LEDGER, observed, KEYED_LEDGER_CONTRACT);

    // #then
    expect({
      differences: result.differences.map((d) => [
        d.kind,
        d.key,
        d.field,
        d.expectedRowRefs,
        d.observedRowRefs,
      ]),
      missing: result.summary.missingOccurrences,
      excess: result.summary.excessOccurrences,
    }).toEqual({
      differences: [['FIELD_CHANGED', ['B'], 'amount', [2], [2]]],
      missing: 0,
      excess: 0,
    });
  });

  it('invalidates the baseline when it repeats a key', () => {
    // #given the trusted side has key A twice
    const expected = 'id,amount\nA,10\nA,11\nB,5\n';

    // #when
    const result = compareCsv(expected, 'id,amount\nA,10\nB,5\n', KEYED_LEDGER_CONTRACT);

    // #then
    expect({
      kinds: result.differences.map((d) => d.kind),
      schemaErrorCount: result.summary.schemaErrorCount,
      matched: result.summary.matchedIdenticalOccurrences,
      rate: result.summary.preservationRate,
    }).toEqual({ kinds: ['SCHEMA_INVALID'], schemaErrorCount: 1, matched: 0, rate: null });
  });

  it('reports a duplicated key in the observed artifact and matches the exact copy first', () => {
    // #given A appears twice in the export, once unchanged
    const observed = 'id,amount\nA,10\nA,99\nB,20.5\nC,30\n';

    // #when
    const result = compareCsv(LEDGER, observed, KEYED_LEDGER_CONTRACT);

    // #then
    expect({
      differences: result.differences.map((d) => [d.kind, d.observedCount, d.observedRowRefs]),
      duplicateKeyCount: result.summary.duplicateKeyCount,
      matched: result.summary.matchedIdenticalOccurrences,
      excess: result.summary.excessOccurrences,
    }).toEqual({
      differences: [['DUPLICATE_KEY', 2, [1, 2]]],
      duplicateKeyCount: 1,
      matched: 3,
      excess: 1,
    });
  });

  it('does not promote any copy of a duplicated key when none matches exactly', () => {
    // #given
    const observed = 'id,amount\nA,11\nA,12\nB,20.5\nC,30\n';

    // #when
    const { summary } = compareCsv(LEDGER, observed, KEYED_LEDGER_CONTRACT);

    // #then
    expect({
      matched: summary.matchedIdenticalOccurrences,
      missing: summary.missingOccurrences,
      excess: summary.excessOccurrences,
      changedFieldCount: summary.changedFieldCount,
    }).toEqual({ matched: 2, missing: 1, excess: 2, changedFieldCount: 0 });
  });

  it('reports a null key in the observed artifact as a schema error', () => {
    // #given a nullable key field
    const contract = makeContract(
      [
        { name: 'id', type: 'string', nullable: true, nullMarkers: [''] },
        { name: 'amount', type: 'decimal', scale: 2 },
      ],
      { identity: { mode: 'uniqueKey', fields: ['id'] } },
    );

    // #when
    const result = compareCsv('id,amount\nA,1\n', 'id,amount\nA,1\n,2\n', contract);

    // #then
    expect(result.differences.map((d) => [d.kind, d.observedRowRefs])).toEqual([['SCHEMA_INVALID', [2]]]);
  });
});

describe('compareArtifacts: schema errors', () => {
  it('reports an invalid observed cell as SCHEMA_INVALID and keeps the row in the denominator', () => {
    // #given
    const observed = 'id,amount\nA,10\nB,twenty\nC,30\n';

    // #when
    const result = compareCsv(LEDGER, observed, LEDGER_CONTRACT, { pairResidualsByOrder: false });

    // #then
    expect({
      schema: result.differences
        .filter((d) => d.kind === 'SCHEMA_INVALID')
        .map((d) => [d.field, d.observedRowRefs, d.message]),
      expectedRows: result.summary.expectedRows,
      observedRows: result.summary.observedRows,
      rate: result.summary.preservationRate,
    }).toEqual({
      schema: [['amount', [2], 'first export row 2, amount: "twenty" is not a plain decimal']],
      expectedRows: 3,
      observedRows: 3,
      rate: 2 / 3,
    });
  });

  it('refuses to match anything when an artifact is structurally invalid', () => {
    // #given an export with broken quoting
    const observed = 'id,amount\nA,"10\n';

    // #when
    const { summary } = compareCsv(LEDGER, observed);

    // #then
    expect({
      matched: summary.matchedIdenticalOccurrences,
      rate: summary.preservationRate,
      schemaErrorCount: summary.schemaErrorCount,
      isEquivalent: summary.isEquivalent,
    }).toEqual({ matched: 0, rate: null, schemaErrorCount: 1, isEquivalent: false });
  });

  it('reports every row of a non-empty baseline missing when the observed artifact is empty', () => {
    // #given
    const empty = 'id,amount\n';

    // #when
    const { summary } = compareCsv(LEDGER, empty);

    // #then
    expect({
      missing: summary.missingOccurrences,
      matched: summary.matchedIdenticalOccurrences,
      rate: summary.preservationRate,
    }).toEqual({ missing: 3, matched: 0, rate: 0 });
  });
});

describe('compareArtifacts: order', () => {
  const strict = makeContract(
    [
      { name: 'id', type: 'string' },
      { name: 'amount', type: 'decimal', scale: 2 },
    ],
    { order: 'strict' },
  );

  it('reports ORDER_CHANGED under strict order when only the sequence differs', () => {
    // #given
    const reordered = 'id,amount\nA,10\nC,30\nB,20.5\n';

    // #when
    const result = compareCsv(LEDGER, reordered, strict);

    // #then
    expect({
      differences: result.differences.map((d) => [d.kind, d.expectedRowRefs, d.observedRowRefs]),
      orderMismatch: result.summary.orderMismatch,
      rate: result.summary.preservationRate,
    }).toEqual({ differences: [['ORDER_CHANGED', [2], [2]]], orderMismatch: true, rate: 1 });
  });

  it('does not report ORDER_CHANGED when content already differs', () => {
    // #given
    const observed = 'id,amount\nC,30\nA,10\n';

    // #when
    const result = compareCsv(LEDGER, observed, strict);

    // #then
    expect(result.summary.orderMismatch).toBe(false);
  });

  it('ignores order by default', () => {
    // #given
    const reordered = 'id,amount\nC,30\nB,20.5\nA,10\n';

    // #when
    const result = compareCsv(LEDGER, reordered);

    // #then
    expect({
      orderMismatch: result.summary.orderMismatch,
      isEquivalent: result.summary.isEquivalent,
    }).toEqual({
      orderMismatch: false,
      isEquivalent: true,
    });
  });
});

describe('compareArtifacts: report shape', () => {
  it('gives differences stable 16-hex ids that are unique within an edge', () => {
    // #given
    const observed = 'id,amount\nA,-10\nB,-20.50\nC,-30\n';

    // #when
    const ids = compareCsv(LEDGER, observed).differences.map((d) => d.id);

    // #then
    expect({ wellFormed: ids.every((id) => /^[0-9a-f]{16}$/.test(id)), unique: new Set(ids).size }).toEqual({
      wellFormed: true,
      unique: 3,
    });
  });

  it('derives ids from the edge, so the same defect has a different id on another edge', () => {
    // #given
    const observed = 'id,amount\nA,10\nC,30\n';

    // #when
    const onSourceExport = compareCsv(LEDGER, observed, LEDGER_CONTRACT, {}, 'source_export');
    const onSourceReexport = compareCsv(LEDGER, observed, LEDGER_CONTRACT, {}, 'source_reexport');

    // #then
    expect(onSourceExport.differences[0]?.id).not.toBe(onSourceReexport.differences[0]?.id);
  });

  it('sorts differences by kind order, then identity', () => {
    // #given missing, excess and schema defects at once
    const observed = 'id,amount\nA,10\nZ,1\nY,2\nQ,bad\n';

    // #when
    const kinds = compareCsv(LEDGER, observed, KEYED_LEDGER_CONTRACT).differences.map((d) => [d.kind, d.key]);

    // #then
    expect(kinds).toEqual([
      ['MISSING_KEY', ['B']],
      ['MISSING_KEY', ['C']],
      ['UNEXPECTED_KEY', ['Y']],
      ['UNEXPECTED_KEY', ['Z']],
      ['SCHEMA_INVALID', undefined],
    ]);
  });

  it('throws when an artifact was parsed against a different contract', () => {
    // #given
    const source = parseText(LEDGER, LEDGER_CONTRACT, 'source');
    const exported = parseText(LEDGER, KEYED_LEDGER_CONTRACT, 'export');

    // #when
    const run = (): unknown => compareArtifacts(source, exported, LEDGER_CONTRACT, 'source_export');

    // #then
    expect(run).toThrow(/different contract/);
  });
});
