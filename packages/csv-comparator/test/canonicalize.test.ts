import { describe, expect, it } from 'vitest';
import { canonicalDate, canonicalDecimal, canonicalInteger } from '../src/index.ts';
import { makeContract, parseText } from './helpers.ts';

describe('canonicalDecimal', () => {
  it.each([
    ['19038', '19038.00'],
    ['19038.0', '19038.00'],
    ['19038.00', '19038.00'],
    ['1.2', '1.20'],
    ['1.20', '1.20'],
    ['-0', '0.00'],
    ['-0.00', '0.00'],
    ['007.5', '7.50'],
    ['-17104.23', '-17104.23'],
  ])('canonicalizes %j at scale 2 to %j', (raw, canonical) => {
    // #given a decimal at scale 2
    // #when
    const result = canonicalDecimal(raw, 2);

    // #then
    expect(result).toEqual({ ok: true, value: canonical });
  });

  it.each([
    ['1.2000', '1.2'],
    ['100', '100'],
    ['-0.0', '0'],
    ['0.000001', '0.000001'],
  ])('canonicalizes %j without a scale to the minimal form %j', (raw, canonical) => {
    // #given no declared scale
    // #when
    const result = canonicalDecimal(raw, undefined);

    // #then
    expect(result).toEqual({ ok: true, value: canonical });
  });

  it('keeps 1234.56 and 1234.00 distinct', () => {
    // #given
    const before = canonicalDecimal('1234.56', 2);

    // #when
    const after = canonicalDecimal('1234.00', 2);

    // #then
    expect(before).not.toEqual(after);
  });

  it('rejects non-zero digits beyond the declared scale instead of rounding', () => {
    // #given
    const raw = '1.234';

    // #when
    const result = canonicalDecimal(raw, 2);

    // #then
    expect(result).toEqual({ ok: false, message: '"1.234" has non-zero digits beyond scale 2' });
  });

  it('accepts trailing zeros beyond the scale because they lose nothing', () => {
    // #given
    const raw = '1.2300';

    // #when
    const result = canonicalDecimal(raw, 2);

    // #then
    expect(result).toEqual({ ok: true, value: '1.23' });
  });

  it.each(['1e3', '1,000', '$5', '+5', '.5', '5.', ' 5', '', '--1', '0x10', 'NaN', 'Infinity'])(
    'rejects %j as not a plain decimal',
    (raw) => {
      // #given a lexically invalid decimal
      // #when
      const result = canonicalDecimal(raw, 2);

      // #then
      expect(result.ok).toBe(false);
    },
  );

  it('compares exactly beyond float precision', () => {
    // #given two values a float64 cannot tell apart
    const a = canonicalDecimal('9007199254740993.01', 2);

    // #when
    const b = canonicalDecimal('9007199254740992.01', 2);

    // #then
    expect(a).not.toEqual(b);
  });

  it('rejects more than 100 digits', () => {
    // #given
    const raw = '1'.repeat(101);

    // #when
    const result = canonicalDecimal(raw, undefined);

    // #then
    expect(result.ok).toBe(false);
  });
});

describe('canonicalInteger', () => {
  it.each([
    ['42', '42'],
    ['-0', '0'],
    ['0007', '7'],
    ['123456789012345678901234567890', '123456789012345678901234567890'],
  ])('canonicalizes %j to %j', (raw, canonical) => {
    // #given
    // #when
    const result = canonicalInteger(raw);

    // #then
    expect(result).toEqual({ ok: true, value: canonical });
  });

  it.each(['1.0', '1e2', '', ' 1', '+1', '1_000'])('rejects %j', (raw) => {
    // #given a value that is not a strict integer
    // #when
    const result = canonicalInteger(raw);

    // #then
    expect(result.ok).toBe(false);
  });
});

describe('canonicalDate', () => {
  it.each([
    ['03/02/2022', ['MM/DD/YYYY', 'YYYY'], '2022-03-02'],
    ['2009', ['MM/DD/YYYY', 'YYYY'], '2009'],
    ['2024-02-29', ['YYYY-MM-DD'], '2024-02-29'],
    ['2000-02-29', ['YYYY-MM-DD'], '2000-02-29'],
    ['31/12/1999', ['DD/MM/YYYY'], '1999-12-31'],
  ] as const)('canonicalizes %j with %j to %j', (raw, formats, canonical) => {
    // #given
    // #when
    const result = canonicalDate(raw, formats);

    // #then
    expect(result).toEqual({ ok: true, value: canonical });
  });

  it.each([
    ['02/30/2024', ['MM/DD/YYYY']],
    ['02/29/2023', ['MM/DD/YYYY']],
    ['1900-02-29', ['YYYY-MM-DD']],
    ['04/31/2024', ['MM/DD/YYYY']],
    ['13/01/2024', ['MM/DD/YYYY']],
    ['3/2/2022', ['MM/DD/YYYY']],
    ['0000', ['YYYY']],
    ['2024-02-29T00:00:00Z', ['YYYY-MM-DD']],
    ['22', ['YYYY']],
  ] as const)('rejects %j under %j', (raw, formats) => {
    // #given an impossible or mis-formatted date
    // #when
    const result = canonicalDate(raw, formats);

    // #then
    expect(result.ok).toBe(false);
  });

  it('uses the first declared format that yields a real date', () => {
    // #given an ambiguous day/month value
    const raw = '04/05/2024';

    // #when
    const result = canonicalDate(raw, ['DD/MM/YYYY', 'MM/DD/YYYY']);

    // #then
    expect(result).toEqual({ ok: true, value: '2024-05-04' });
  });

  it('falls through to a later format when the first one is not a real date', () => {
    // #given 13 cannot be a month, so DD/MM/YYYY is the only reading
    const raw = '13/05/2024';

    // #when
    const result = canonicalDate(raw, ['MM/DD/YYYY', 'DD/MM/YYYY']);

    // #then
    expect(result).toEqual({ ok: true, value: '2024-05-13' });
  });
});

describe('cell policy through parseArtifact', () => {
  const contract = makeContract([
    { name: 'label', type: 'string', nullable: true, nullMarkers: ['NULL'] },
    { name: 'amount', type: 'decimal', scale: 2, nullable: true, nullMarkers: ['NULL'] },
  ]);

  it('keeps empty, null and zero distinct', () => {
    // #given an empty string, a declared null and a zero
    const csv = 'label,amount\n,0\nNULL,NULL\n0,0.00\n';

    // #when
    const parsed = parseText(csv, contract);

    // #then
    expect(parsed.rows.map((row) => row.canonical)).toEqual([
      ['', '0.00'],
      [null, null],
      ['0', '0.00'],
    ]);
  });

  it('does not treat an empty cell as null unless "" is a null marker', () => {
    // #given an empty amount with only NULL declared as a marker
    const csv = 'label,amount\nx,\n';

    // #when
    const parsed = parseText(csv, contract);

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual(['"" is not a plain decimal']);
  });

  it('rejects a null marker in a non-nullable field', () => {
    // #given
    const strict = makeContract([{ name: 'amount', type: 'decimal', nullMarkers: [''] }]);

    // #when
    const parsed = parseText('amount\n\n', strict);

    // #then
    expect(parsed.schemaErrors.map((error) => error.message)).toEqual([
      'null marker "" in a non-nullable field',
    ]);
  });

  it('keeps string whitespace and case unless trim is declared', () => {
    // #given
    const csv = 'label,amount\n" Acme ",1\nacme,1\n';

    // #when
    const parsed = parseText(csv, contract);

    // #then
    expect(parsed.rows.map((row) => row.canonical[0])).toEqual([' Acme ', 'acme']);
  });

  it('trims and NFC-normalizes only when the field declares it', () => {
    // #given "e" followed by a combining acute accent, padded with spaces
    const normalizing = makeContract([
      { name: 'label', type: 'string', trim: true, unicodeNormalization: 'NFC' },
    ]);
    const decomposed = '  Café  ';

    // #when
    const parsed = parseText(`label\n${decomposed}\n`, normalizing);

    // #then
    expect(parsed.rows[0]?.canonical).toEqual(['Café']);
  });

  it('maps declared boolean lexemes to true and false and rejects anything else', () => {
    // #given
    const flags = makeContract([{ name: 'flag', type: 'boolean', trueValues: ['Y'], falseValues: ['N'] }]);

    // #when
    const parsed = parseText('flag\nY\nN\ny\n', flags);

    // #then
    expect({
      canonical: parsed.rows.map((row) => row.canonical[0]),
      errors: parsed.schemaErrors.map((error) => [error.row, error.message]),
    }).toEqual({
      canonical: ['true', 'false'],
      errors: [[3, '"y" is not a declared boolean value']],
    });
  });
});
