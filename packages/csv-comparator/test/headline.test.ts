import type { EdgeSummary } from '@returntrip/contracts';
import { describe, expect, it } from 'vitest';
import { compareArtifacts, formatCount, headline } from '../src/index.ts';
import { LEDGER_CONTRACT, parseText } from './helpers.ts';

function summary(overrides: Partial<EdgeSummary>): EdgeSummary {
  return {
    edge: 'source_export',
    isEquivalent: false,
    expectedRows: 1000,
    observedRows: 1000,
    matchedIdenticalOccurrences: 0,
    missingKeyCount: 0,
    unexpectedKeyCount: 0,
    missingOccurrences: 0,
    excessOccurrences: 0,
    duplicateKeyCount: 0,
    changedKeyCount: 0,
    changedFieldCount: 0,
    schemaErrorCount: 0,
    orderMismatch: false,
    preservationRate: 0,
    changedFields: [],
    ...overrides,
  };
}

describe('headline', () => {
  it('names the changed field and row counts for an in-place edit', () => {
    // #given
    const flipped = summary({
      changedKeyCount: 1000,
      changedFieldCount: 1000,
      changedFields: [{ field: 'amount', rows: 1000 }],
    });

    // #when
    const sentence = headline(flipped);

    // #then
    expect(sentence).toBe('1,000 of 1,000 rows came back, but amount changed in 1,000 rows');
  });

  it('reports missing rows with the preserved count', () => {
    // #given
    const lossy = summary({ observedRows: 994, matchedIdenticalOccurrences: 994, missingOccurrences: 6 });

    // #when
    const sentence = headline(lossy);

    // #then
    expect(sentence).toBe('6 rows missing, 994 of 1,000 preserved');
  });

  it('uses singular nouns for counts of one', () => {
    // #given
    const oneExtra = summary({ observedRows: 1001, matchedIdenticalOccurrences: 1000, excessOccurrences: 1 });

    // #when
    const sentence = headline(oneExtra);

    // #then
    expect(sentence).toBe('1 extra row, 1,000 of 1,000 preserved');
  });

  it('names two fields and counts the rest', () => {
    // #given
    const many = summary({
      matchedIdenticalOccurrences: 990,
      changedKeyCount: 10,
      changedFields: [
        { field: 'amount', rows: 10 },
        { field: 'check_date', rows: 4 },
        { field: 'vendor_name', rows: 1 },
        { field: 'voucher_number', rows: 1 },
      ],
    });

    // #when
    const sentence = headline(many);

    // #then
    expect(sentence).toBe(
      '1,000 of 1,000 rows came back, but amount changed in 10 rows, check_date in 4 rows and 2 other fields',
    );
  });

  it('appends losses to field changes', () => {
    // #given
    const mixed = summary({
      matchedIdenticalOccurrences: 900,
      changedKeyCount: 50,
      missingOccurrences: 50,
      changedFields: [{ field: 'amount', rows: 50 }],
    });

    // #when
    const sentence = headline(mixed);

    // #then
    expect(sentence).toBe('950 of 1,000 rows came back, but amount changed in 50 rows, plus 50 rows missing');
  });

  it('describes an order-only difference', () => {
    // #given
    const reordered = summary({
      matchedIdenticalOccurrences: 1000,
      orderMismatch: true,
      preservationRate: 1,
    });

    // #when
    const sentence = headline(reordered);

    // #then
    expect(sentence).toBe('Rows in a different order, 1,000 of 1,000 preserved');
  });

  it('says the comparison could not run when schema errors blocked it', () => {
    // #given
    const blocked = summary({ schemaErrorCount: 2, preservationRate: null, observedRows: 0 });

    // #when
    const sentence = headline(blocked);

    // #then
    expect(sentence).toBe('Could not compare: 2 schema errors in the artifacts');
  });

  it('reports a clean round trip', () => {
    // #given
    const clean = summary({ isEquivalent: true, matchedIdenticalOccurrences: 1000, preservationRate: 1 });

    // #when
    const sentence = headline(clean);

    // #then
    expect(sentence).toBe('All 1,000 of 1,000 rows came back unchanged');
  });

  it('reports two empty artifacts without inventing a rate', () => {
    // #given
    const empty = summary({ isEquivalent: true, expectedRows: 0, observedRows: 0, preservationRate: null });

    // #when
    const sentence = headline(empty);

    // #then
    expect(sentence).toBe('Both artifacts have no data rows');
  });

  it('reads its numbers from a real comparison', () => {
    // #given
    const expected = parseText('id,amount\nA,1\nB,2\nC,3\n', LEDGER_CONTRACT, 'source');
    const observed = parseText('id,amount\nA,1\nC,3\n', LEDGER_CONTRACT, 'export');

    // #when
    const sentence = headline(compareArtifacts(expected, observed, LEDGER_CONTRACT, 'source_export').summary);

    // #then
    expect(sentence).toBe('1 row missing, 2 of 3 preserved');
  });
});

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1,000'],
    [1234567, '1,234,567'],
  ])('formats %d as %s', (count, text) => {
    // #given
    // #when
    const formatted = formatCount(count);

    // #then
    expect(formatted).toBe(text);
  });
});
