import type { Difference } from '@returntrip/contracts';
import { describe, expect, it } from 'vitest';
import { compareArtifacts, toSpreadsheetSafeCsv } from '../src/index.ts';
import { LEDGER_CONTRACT, makeContract, parseText } from './helpers.ts';

const REPORT_CONTRACT = makeContract(
  [
    'id',
    'edge',
    'kind',
    'key',
    'field',
    'expected_raw',
    'observed_raw',
    'expected_canonical',
    'observed_canonical',
    'expected_count',
    'observed_count',
    'expected_rows',
    'observed_rows',
    'message',
  ].map((name) => ({ name, type: 'string' })),
);

function difference(overrides: Partial<Difference>): Difference {
  return {
    id: '0123456789abcdef',
    edge: 'source_export',
    kind: 'FIELD_CHANGED',
    expectedRowRefs: [1],
    observedRowRefs: [1],
    message: 'changed',
    ...overrides,
  };
}

function dataLine(csv: string): string {
  return csv.split('\r\n')[1] ?? '';
}

describe('toSpreadsheetSafeCsv', () => {
  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+1+1', "'+1+1"],
    ['-17104.23', "'-17104.23"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
  ])('prefixes the formula-like cell %j with an apostrophe', (value, encoded) => {
    // #given a difference whose observed value would be evaluated by a spreadsheet
    const csv = toSpreadsheetSafeCsv([difference({ field: 'note', observedRaw: value })]);

    // #when
    const line = dataLine(csv);

    // #then
    expect(line).toContain(`,${encoded},`);
  });

  it('leaves ordinary values untouched', () => {
    // #given
    const csv = toSpreadsheetSafeCsv([difference({ field: 'amount', expectedRaw: '17104.23' })]);

    // #when
    const line = dataLine(csv);

    // #then
    expect(line).toContain(',17104.23,');
  });

  it('quotes cells containing commas, quotes or newlines', () => {
    // #given
    const csv = toSpreadsheetSafeCsv([difference({ message: 'vendor "A, B"\nchanged' })]);

    // #when
    const line = csv.slice(csv.indexOf('\r\n') + 2);

    // #then
    expect(line.endsWith(',"vendor ""A, B""\nchanged"\r\n')).toBe(true);
  });

  it('writes a header even when there are no differences', () => {
    // #given
    const differences: Difference[] = [];

    // #when
    const csv = toSpreadsheetSafeCsv(differences);

    // #then
    expect(csv).toBe(
      'id,edge,kind,key,field,expected_raw,observed_raw,expected_canonical,observed_canonical,' +
        'expected_count,observed_count,expected_rows,observed_rows,message\r\n',
    );
  });

  it('produces CSV the strict parser reads back with one row per difference', () => {
    // #given a real report whose raw values contain newlines, quotes and a formula trigger
    const expected = parseText('id,amount\n"A\nB",1\nC,2\n', LEDGER_CONTRACT, 'source');
    const observed = parseText('id,amount\n"A\n""B""",1\n=C,-2\n', LEDGER_CONTRACT, 'export');
    const report = compareArtifacts(expected, observed, LEDGER_CONTRACT, 'source_export');

    // #when
    const reread = parseText(toSpreadsheetSafeCsv(report.differences), REPORT_CONTRACT);

    // #then
    expect({ rows: reread.rowCount, errors: reread.schemaErrors }).toEqual({ rows: 3, errors: [] });
  });
});
