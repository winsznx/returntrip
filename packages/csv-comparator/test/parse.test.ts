import { createHash } from 'node:crypto';
import type { DataContract } from '@returntrip/contracts';
import { describe, expect, it } from 'vitest';
import { parseArtifact } from '../src/index.ts';
import { bytes, LEDGER_CONTRACT, makeContract, parseText, toCsv } from './helpers.ts';

const TEXT_CONTRACT = makeContract([
  { name: 'id', type: 'string' },
  { name: 'note', type: 'string' },
]);

describe('parseArtifact: CSV syntax', () => {
  it('reads quoted commas, escaped quotes, embedded newlines and non-ASCII text exactly', () => {
    // #given
    const csv = 'id,note\r\n1,"Café Núñez, LLC"\r\n2,"said ""hi""\nthen left"\r\n3,\r\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.rows.map((row) => row.raw.note)).toEqual(['Café Núñez, LLC', 'said "hi"\nthen left', '']);
  });

  it('numbers data rows from 1 with the header excluded, even across embedded newlines', () => {
    // #given
    const csv = 'id,note\n1,"a\nb\nc"\n2,d\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it.each([
    ['id,note\r\n1,a\r\n', 'crlf'],
    ['id,note\n1,a\n', 'lf'],
    ['id,note\r\n1,a\n', 'mixed'],
    ['id,note', 'none'],
  ] as const)('records line endings of %j as %s', (csv, expected) => {
    // #given a file with a known terminator style
    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.lineEndings).toBe(expected);
  });

  it('keeps every row of a file that mixes CRLF and LF terminators', () => {
    // #given a bare LF after a CRLF must still end the record, not join two rows
    const csv = 'id,note\r\n1,a\n2,b\r\n3,c';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.rows.map((row) => row.raw)).toEqual([
      { id: '1', note: 'a' },
      { id: '2', note: 'b' },
      { id: '3', note: 'c' },
    ]);
  });

  it('records and strips a UTF-8 byte order mark', () => {
    // #given
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('id,note\n1,a\n')]);

    // #when
    const parsed = parseArtifact(withBom, TEXT_CONTRACT, { artifact: 'export', maxRows: 10 });

    // #then
    expect({ bom: parsed.bom, header: parsed.header, errors: parsed.schemaErrors }).toEqual({
      bom: true,
      header: ['id', 'note'],
      errors: [],
    });
  });

  it('uses the delimiter from the contract instead of guessing', () => {
    // #given a semicolon contract and a value containing a comma
    const contract = makeContract(
      [
        { name: 'id', type: 'string' },
        { name: 'note', type: 'string' },
      ],
      { delimiter: ';' },
    );

    // #when
    const parsed = parseText('id;note\n1;a,b\n', contract);

    // #then
    expect(parsed.rows[0]?.raw).toEqual({ id: '1', note: 'a,b' });
  });

  it('hashes and measures the raw bytes', () => {
    // #given
    const csv = 'id,note\n1,a\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect({ sha256: parsed.sha256, byteLength: parsed.byteLength }).toEqual({
      sha256: createHash('sha256').update(csv).digest('hex'),
      byteLength: 12,
    });
  });
});

describe('parseArtifact: structural defects', () => {
  it.each([
    ['quote inside an unquoted field', 'id,note\n1,a"b\n', /quote inside an unquoted field on line 2/],
    ['text after a closing quote', 'id,note\n1,"ab"c\n', /unexpected text after a closing quote on line 2/],
    ['an unclosed quote', 'id,note\n1,"ab\n', /never closed/],
    ['a bare carriage return', 'id,note\r1,a\r', /carriage return without line feed/],
  ])('rejects %s as an incomparable artifact', (_label, csv, message) => {
    // #given malformed CSV
    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.comparable).toBe(false);
    expect(parsed.schemaErrors.map((error) => error.message).join('\n')).toMatch(message);
  });

  it('reports the data row where malformed quoting stopped the reader', () => {
    // #given row 2 is malformed
    const csv = 'id,note\n1,a\n2,b"c\n3,d\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.schemaErrors).toEqual([
      {
        artifact: 'source',
        row: 2,
        column: null,
        message: 'quote inside an unquoted field on line 3; reading stopped at data row 2',
      },
    ]);
  });

  it('rejects invalid UTF-8 without throwing', () => {
    // #given 0xC3 starts a two-byte sequence that 0x28 cannot continue
    const invalid = new Uint8Array([...bytes('id,note\n1,'), 0xc3, 0x28, 0x0a]);

    // #when
    const parsed = parseArtifact(invalid, TEXT_CONTRACT, { artifact: 'export', maxRows: 10 });

    // #then
    expect({ comparable: parsed.comparable, errors: parsed.schemaErrors }).toEqual({
      comparable: false,
      errors: [{ artifact: 'export', row: null, column: null, message: 'artifact is not valid UTF-8' }],
    });
  });

  it('rejects a zero-byte file because a header row is required', () => {
    // #given
    const empty = new Uint8Array();

    // #when
    const parsed = parseArtifact(empty, TEXT_CONTRACT, { artifact: 'source', maxRows: 10 });

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual([
      'artifact is empty; a header row is required',
    ]);
  });

  it('rejects duplicate headers', () => {
    // #given
    const csv = 'id,note,note\n1,a,b\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.schemaErrors.map((error) => [error.column, error.message])).toEqual([
      ['note', 'duplicate header "note"'],
    ]);
  });

  it('rejects a missing declared header', () => {
    // #given
    const csv = 'id\n1\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual(['missing declared header "note"']);
  });

  it('matches headers exactly, so case and whitespace differences are missing headers', () => {
    // #given
    const csv = 'ID, note\n1,a\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual([
      'missing declared header "id"',
      'missing declared header "note"',
      'unexpected column "ID"',
      'unexpected column " note"',
    ]);
  });

  it('rejects an unexpected column when extraColumns is reject', () => {
    // #given
    const csv = 'id,note,secret\n1,a,x\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual(['unexpected column "secret"']);
  });

  it('rejects more data rows than maxRows', () => {
    // #given
    const csv = 'id,note\n1,a\n2,b\n3,c\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT, 'source', { maxRows: 2 });

    // #then
    expect({ comparable: parsed.comparable, messages: parsed.schemaErrors.map((e) => e.message) }).toEqual({
      comparable: false,
      messages: ['artifact has more than 2 data rows'],
    });
  });

  it('accepts exactly maxRows data rows', () => {
    // #given
    const csv = 'id,note\n1,a\n2,b';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT, 'source', { maxRows: 2 });

    // #then
    expect({ comparable: parsed.comparable, rowCount: parsed.rowCount }).toEqual({
      comparable: true,
      rowCount: 2,
    });
  });
});

describe('parseArtifact: column policy', () => {
  it('tolerates a different header order by matching columns by name', () => {
    // #given
    const csv = 'note,id\na,1\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.rows[0]?.canonical).toEqual(['1', 'a']);
  });

  it('drops undeclared columns under ignoreDeclaredOnly', () => {
    // #given
    const contract = makeContract(
      [
        { name: 'id', type: 'string' },
        { name: 'note', type: 'string' },
      ],
      { extraColumns: 'ignoreDeclaredOnly' },
    );

    // #when
    const parsed = parseText('id,extra,note\n1,x,a\n', contract);

    // #then
    expect({ errors: parsed.schemaErrors, raw: parsed.rows[0]?.raw }).toEqual({
      errors: [],
      raw: { id: '1', note: 'a' },
    });
  });

  it('always drops ignoredColumns, even when extra columns are rejected', () => {
    // #given
    const contract = makeContract(
      [
        { name: 'id', type: 'string' },
        { name: 'note', type: 'string' },
      ],
      { ignoredColumns: ['exported_at'] },
    );

    // #when
    const parsed = parseText('id,note,exported_at\n1,a,2026-11-25T10:00:00Z\n', contract);

    // #then
    expect({ errors: parsed.schemaErrors, canonical: parsed.rows[0]?.canonical }).toEqual({
      errors: [],
      canonical: ['1', 'a'],
    });
  });

  it('keeps a column literally named __proto__ as plain data', () => {
    // #given
    const contract = makeContract([{ name: '__proto__', type: 'string' }]);

    // #when
    const parsed = parseText('__proto__\nvalue\n', contract);

    // #then
    expect(Object.entries(parsed.rows[0]?.raw ?? {})).toEqual([['__proto__', 'value']]);
  });
});

describe('parseArtifact: row-level defects', () => {
  it('marks a row with the wrong width invalid and keeps the rest', () => {
    // #given
    const csv = 'id,note\n1,a\n2,b,extra\n3,c\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect({
      comparable: parsed.comparable,
      rowCount: parsed.rowCount,
      invalidRowCount: parsed.invalidRowCount,
      validRows: parsed.rows.map((row) => row.rowNumber),
      errors: parsed.schemaErrors.map((error) => [error.row, error.message]),
    }).toEqual({
      comparable: true,
      rowCount: 3,
      invalidRowCount: 1,
      validRows: [1, 3],
      errors: [[2, 'row on line 3 has 3 fields; header has 2']],
    });
  });

  it('treats a blank line inside the data as an invalid row, not as nothing', () => {
    // #given
    const csv = 'id,note\n1,a\n\n2,b\n';

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual(['blank line 3; expected 2 fields']);
  });

  it('rejects a field larger than maxFieldBytes, counting UTF-8 bytes', () => {
    // #given four "é" characters are 8 UTF-8 bytes
    const csv = toCsv([
      ['id', 'note'],
      ['1', 'éééé'],
      ['2', 'ééé'],
    ]);

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT, 'source', { maxFieldBytes: 7 });

    // #then
    expect(parsed.schemaErrors).toEqual([
      { artifact: 'source', row: 1, column: 'note', message: 'field exceeds 7 bytes' },
    ]);
  });

  it('reports an invalid cell with its row and column and excludes the row', () => {
    // #given
    const csv = 'id,amount\nA,1.234\nB,2.00\n';

    // #when
    const parsed = parseText(csv, LEDGER_CONTRACT);

    // #then
    expect({ errors: parsed.schemaErrors, rows: parsed.rows.map((row) => row.raw.id) }).toEqual({
      errors: [
        {
          artifact: 'source',
          row: 1,
          column: 'amount',
          message: '"1.234" has non-zero digits beyond scale 2',
        },
      ],
      rows: ['B'],
    });
  });
});

describe('parseArtifact: canonical tuples', () => {
  it('encodes tuples unambiguously, so a delimiter inside a value cannot collide with two values', () => {
    // #given two rows that would collide if values were joined with a comma
    const csv = toCsv([
      ['id', 'note'],
      ['a,b', 'c'],
      ['a', 'b,c'],
    ]);

    // #when
    const parsed = parseText(csv, TEXT_CONTRACT);

    // #then
    expect(new Set(parsed.rows.map((row) => row.tupleKey)).size).toBe(2);
  });
});

describe('parseArtifact: programmer errors', () => {
  it('throws for a non-positive maxRows', () => {
    // #given
    const run = (): unknown =>
      parseArtifact(bytes('id,note\n'), TEXT_CONTRACT, { artifact: 'source', maxRows: 0 });

    // #when / #then
    expect(run).toThrow(RangeError);
  });

  it('throws for a date field without formats, which only an unvalidated contract can have', () => {
    // #given a contract object assembled without DataContractSchema
    const unvalidated: DataContract = {
      ...TEXT_CONTRACT,
      fields: [
        {
          name: 'd',
          type: 'date',
          nullable: false,
          nullMarkers: [],
          trim: false,
          unicodeNormalization: 'none',
        },
      ],
    };

    // #when
    const run = (): unknown => parseArtifact(bytes('d\n'), unvalidated, { artifact: 'source', maxRows: 1 });

    // #then
    expect(run).toThrow(/declares no formats/);
  });
});
