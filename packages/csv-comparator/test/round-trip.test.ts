import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareRoundTrip, headline, type ParsedArtifact, parseArtifact } from '../src/index.ts';
import {
  bytes,
  KEYED_LEDGER_CONTRACT,
  LEDGER_CONTRACT,
  PAYMENTS_CONTRACT,
  parseText,
  toCsv,
} from './helpers.ts';

const LEDGER = 'id,amount\nA,10.00\nB,20.50\nC,30\n';
const SOURCE_CSV = new URL('../../../examples/payment-roundtrip/source.csv', import.meta.url);

function ledgerTrip(source: string, exported: string, reexported: string, contract = LEDGER_CONTRACT) {
  return compareRoundTrip(
    {
      source: parseText(source, contract, 'source'),
      exported: parseText(exported, contract, 'export'),
      reexported: parseText(reexported, contract, 'reexport'),
    },
    contract,
  );
}

describe('compareRoundTrip', () => {
  it('computes the three required edges in contract order', () => {
    // #given
    const same = LEDGER;

    // #when
    const result = ledgerTrip(same, same, same);

    // #then
    expect(result.edges.map((edge) => edge.summary.edge)).toEqual([
      'source_export',
      'export_reexport',
      'source_reexport',
    ]);
  });

  it('is equivalent when every edge matches', () => {
    // #given the export and re-export differ only in order and formatting
    const exported = 'id,amount\r\nC,30.00\r\nB,20.5\r\nA,10\r\n';

    // #when
    const result = ledgerTrip(LEDGER, exported, LEDGER);

    // #then
    expect(result.verdict).toBe('equivalent');
  });

  it('fails source_export even when source_reexport passes, so a clean endpoint cannot hide a bad middle', () => {
    // #given the export is wrong but the re-export matches the source
    const brokenExport = 'id,amount\nA,10\nB,0\nC,30\n';

    // #when
    const result = ledgerTrip(LEDGER, brokenExport, LEDGER);

    // #then
    expect({
      verdict: result.verdict,
      equivalentByEdge: result.edges.map((edge) => [edge.summary.edge, edge.summary.isEquivalent]),
    }).toEqual({
      verdict: 'mismatch',
      equivalentByEdge: [
        ['source_export', false],
        ['export_reexport', false],
        ['source_reexport', true],
      ],
    });
  });

  it('is invalid when the trusted source fails the contract', () => {
    // #given
    const badSource = 'id,amount\nA,1.234\n';

    // #when
    const result = ledgerTrip(badSource, LEDGER, LEDGER);

    // #then
    expect(result.verdict).toBe('invalid');
  });

  it('is invalid when a keyed source repeats a key', () => {
    // #given
    const duplicateKeys = 'id,amount\nA,1\nA,2\n';

    // #when
    const result = ledgerTrip(duplicateKeys, duplicateKeys, duplicateKeys, KEYED_LEDGER_CONTRACT);

    // #then
    expect(result.verdict).toBe('invalid');
  });

  it('is a mismatch, not invalid, when only the export is malformed', () => {
    // #given
    const malformed = 'id,amount\nA,"10\n';

    // #when
    const result = ledgerTrip(LEDGER, malformed, LEDGER);

    // #then
    expect(result.verdict).toBe('mismatch');
  });

  it('throws when artifacts are passed in the wrong roles', () => {
    // #given
    const source = parseText(LEDGER, LEDGER_CONTRACT, 'source');
    const exported = parseText(LEDGER, LEDGER_CONTRACT, 'export');

    // #when
    const run = (): unknown =>
      compareRoundTrip({ source: exported, exported: source, reexported: exported }, LEDGER_CONTRACT);

    // #then
    expect(run).toThrow(/expected the source artifact/);
  });
});

describe('compareRoundTrip on the City of Chicago payments sample', () => {
  const sourceBytes = new Uint8Array(readFileSync(SOURCE_CSV));
  const parse = (data: Uint8Array, artifact: ParsedArtifact['artifact']): ParsedArtifact =>
    parseArtifact(data, PAYMENTS_CONTRACT, { artifact, maxRows: 50_000 });

  it('parses all 1,000 rows with no schema errors under the demo contract', () => {
    // #given
    const data = sourceBytes;

    // #when
    const parsed = parse(data, 'source');

    // #then
    expect({ rows: parsed.rows.length, errors: parsed.schemaErrors }).toEqual({ rows: 1000, errors: [] });
  });

  it('pins every amount flip to its own row with exact before and after values', () => {
    // #given an export that flips the sign of every amount and keeps everything else
    const source = parse(sourceBytes, 'source');
    const header = source.header;
    const flippedRows = source.rows.map((row) =>
      header.map((column) => {
        const value = row.raw[column] ?? '';
        if (column !== 'amount') return value;
        return value.startsWith('-') ? value.slice(1) : `-${value}`;
      }),
    );
    const exported = parse(bytes(toCsv([header, ...flippedRows])), 'export');

    // #when
    const result = compareRoundTrip(
      { source, exported, reexported: parse(sourceBytes, 'reexport') },
      PAYMENTS_CONTRACT,
    );
    const sourceExport = result.edges[0];

    // #then
    expect({
      verdict: result.verdict,
      headline: sourceExport ? headline(sourceExport.summary) : '',
      firstChange: sourceExport?.differences[0]?.message,
      changedRows: sourceExport?.differences.filter((d) => d.kind === 'FIELD_CHANGED' && d.field === 'amount')
        .length,
    }).toEqual({
      verdict: 'mismatch',
      headline: '1,000 of 1,000 rows came back, but amount changed in 1,000 rows',
      firstChange:
        'amount changed from "17104.23" to "-17104.23" (trusted source row 1, first export row 1, paired by row order)',
      changedRows: 1000,
    });
  });
});
