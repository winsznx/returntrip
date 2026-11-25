import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv } from '../src/csv/parse.ts';
import { formatCsv } from '../src/csv/write.ts';
import { isValidCheckDate } from '../src/domain/check-date.ts';
import { formatCents, parseAmountCents } from '../src/domain/money.ts';
import { draftWorkspace } from '../src/domain/workspace.ts';
import { escapeHtml } from '../src/views/html.ts';

describe('parseAmountCents', () => {
  it.each([
    ['19038', 1_903_800n],
    ['17104.23', 1_710_423n],
    ['-5.1', -510n],
    ['0.07', 7n],
    ['9007199254740993.99', 900_719_925_474_099_399n],
  ])('parses %s exactly into integer cents', (text, cents) => {
    // #given a plain decimal amount
    // #when it is parsed
    const parsed = parseAmountCents(text);
    // #then no precision is lost, even beyond float range
    expect(parsed).toBe(cents);
  });

  it.each(['', '1,000.00', '1.234', '+5', '1e3', ' 1.00', '.50', '92233720368547758.08'])(
    'rejects %j',
    (text) => {
      // #given text that is not a plain decimal with up to two places, or overflows int64 cents
      // #when it is parsed
      const parsed = parseAmountCents(text);
      // #then it is refused
      expect(parsed).toBeUndefined();
    },
  );
});

describe('formatCents', () => {
  it.each([
    [1_903_800n, '19038.00'],
    [-510n, '-5.10'],
    [7n, '0.07'],
    [-7n, '-0.07'],
    [0n, '0.00'],
  ])('formats %s cents as %s', (cents, text) => {
    // #given integer cents
    // #when they are formatted
    const formatted = formatCents(cents);
    // #then exactly two fraction digits are written
    expect(formatted).toBe(text);
  });
});

describe('isValidCheckDate', () => {
  it.each(['03/17/2021', '02/29/2024', '2003', '12/31/1999'])('accepts %s', (text) => {
    // #given a real MM/DD/YYYY date or a bare year
    // #when it is validated
    const valid = isValidCheckDate(text);
    // #then it passes
    expect(valid).toBe(true);
  });

  it.each(['02/29/2023', '02/30/2024', '13/01/2024', '00/10/2024', '2024-01-05', '3/7/2021', '03', ''])(
    'rejects %j',
    (text) => {
      // #given an impossible date or another format
      // #when it is validated
      const valid = isValidCheckDate(text);
      // #then it fails
      expect(valid).toBe(false);
    },
  );
});

describe('parseCsv', () => {
  it('reads quoted commas, doubled quotes, embedded newlines and empty fields', () => {
    // #given RFC 4180 text exercising every quoting rule
    const text = 'a,"b, c","say ""hi""","line\r\nbreak",\r\n,x\r\n';
    // #when it is parsed
    const records = parseCsv(text);
    // #then every field keeps its exact value
    expect(records).toEqual([
      ['a', 'b, c', 'say "hi"', 'line\r\nbreak', ''],
      ['', 'x'],
    ]);
  });

  it('accepts LF-only line endings and a missing final newline', () => {
    // #given Unix line endings and no trailing newline
    // #when it is parsed
    const records = parseCsv('a,b\nc,d');
    // #then both records are read
    expect(records).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('returns no records for empty input', () => {
    // #given an empty string
    // #when it is parsed
    const records = parseCsv('');
    // #then there are no records
    expect(records).toEqual([]);
  });

  it.each([
    ['a,"open\n', 'Quoted field is never closed', 1],
    ['a,b"c\n', 'Unexpected quote inside an unquoted field', 1],
    ['x\n"done"tail,b\n', 'Unexpected text after a closing quote', 2],
  ])('rejects malformed input %j', (text, reason, line) => {
    // #given text that breaks RFC 4180 quoting
    // #when it is parsed
    const parse = (): string[][] => parseCsv(text);
    // #then a CsvParseError names the problem and its line
    expect(parse).toThrowError(new CsvParseError(reason, line));
  });
});

describe('formatCsv', () => {
  it('quotes only fields that need it and ends every record with CRLF', () => {
    // #given fields with and without special characters
    const records = [
      ['plain', 'has,comma', 'has "quote"', 'has\nnewline', '', 'Café Núñez'],
      ['x', 'y'],
    ];
    // #when they are serialized
    const text = formatCsv(records);
    // #then the output follows RFC 4180
    expect(text).toBe('plain,"has,comma","has ""quote""","has\nnewline",,Café Núñez\r\nx,y\r\n');
  });

  it('round-trips through parseCsv unchanged', () => {
    // #given records full of quoting edge cases
    const records = [['"', ',', '\r\n', '\r', ' padded ', '']];
    // #when they are written and read back
    const roundTripped = parseCsv(formatCsv(records));
    // #then the values are identical
    expect(roundTripped).toEqual(records);
  });
});

describe('draftWorkspace', () => {
  it('collapses whitespace and derives an ASCII slug', () => {
    // #given a messy name with accents
    // #when it is drafted
    const draft = draftWorkspace('  Café   Núñez:  Q4 ');
    // #then the name is tidied and the slug is URL safe
    expect(draft).toEqual({ ok: true, name: 'Café Núñez: Q4', slug: 'cafe-nunez-q4' });
  });

  it('rejects a blank name', () => {
    // #given only whitespace
    // #when it is drafted
    const draft = draftWorkspace('   ');
    // #then it is refused
    expect(draft).toEqual({ ok: false, error: 'Enter a workspace name.' });
  });

  it('rejects a name over 80 characters', () => {
    // #given 81 characters
    // #when it is drafted
    const draft = draftWorkspace('a'.repeat(81));
    // #then it is refused
    expect(draft.ok).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that can break out of text or attribute context', () => {
    // #given markup with both quote styles
    // #when it is escaped
    const escaped = escapeHtml(`<a href="x" title='y'>&</a>`);
    // #then no raw markup characters remain
    expect(escaped).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
