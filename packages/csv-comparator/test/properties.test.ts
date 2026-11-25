import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalDecimal, compareArtifacts, type ParsedArtifact } from '../src/index.ts';
import { makeContract, parseText, toCsv } from './helpers.ts';

const CONTRACT = makeContract([
  { name: 'label', type: 'string' },
  { name: 'amount', type: 'decimal', scale: 2 },
  { name: 'count', type: 'integer' },
]);
const HEADER = CONTRACT.fields.map((field) => field.name);

/** Cents as exact decimal text, e.g. -1234n -> "-12.34". */
function centsToText(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const rowArbitrary = fc.tuple(
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }).map(centsToText),
  fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }).map(String),
);
const rowsArbitrary = fc.array(rowArbitrary, { maxLength: 40 });
const lineEndingArbitrary = fc.constantFrom('\n', '\r\n');

function parseRows(
  rows: readonly (readonly string[])[],
  artifact: ParsedArtifact['artifact'],
  lineEnding = '\n',
): ParsedArtifact {
  return parseText(toCsv([HEADER, ...rows], lineEnding), CONTRACT, artifact);
}

describe('properties', () => {
  it('reads back exactly what an RFC 4180 writer wrote', () => {
    // #given any rows, including commas, quotes, CR and LF inside values
    fc.assert(
      fc.property(rowsArbitrary, lineEndingArbitrary, (rows, lineEnding) => {
        // #when
        const parsed = parseRows(rows, 'source', lineEnding);

        // #then
        expect(parsed.rows.map((row) => HEADER.map((name) => row.raw[name]))).toEqual(rows);
      }),
    );
  });

  it('finds every artifact equivalent to itself', () => {
    // #given
    fc.assert(
      fc.property(rowsArbitrary, (rows) => {
        const artifact = parseRows(rows, 'source');

        // #when
        const result = compareArtifacts(artifact, artifact, CONTRACT, 'source_export');

        // #then
        expect(result.summary.isEquivalent).toBe(true);
      }),
    );
  });

  it('finds an artifact equivalent to any shuffle of itself, with any line endings', () => {
    // #given
    fc.assert(
      fc.property(
        rowsArbitrary.chain((rows) =>
          fc.tuple(
            fc.constant(rows),
            fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }),
          ),
        ),
        lineEndingArbitrary,
        ([rows, shuffled], lineEnding) => {
          // #when
          const result = compareArtifacts(
            parseRows(rows, 'source'),
            parseRows(shuffled, 'export', lineEnding),
            CONTRACT,
            'source_export',
          );

          // #then
          expect(result.summary.isEquivalent).toBe(true);
        },
      ),
    );
  });

  it('conserves counts: matched + missing = expected and matched + excess = observed', () => {
    // #given an observed side built from a sample of the expected rows plus new rows
    fc.assert(
      fc.property(
        rowsArbitrary.chain((rows) => fc.tuple(fc.constant(rows), fc.subarray(rows), rowsArbitrary)),
        ([rows, kept, added]) => {
          // #when
          const { summary } = compareArtifacts(
            parseRows(rows, 'source'),
            parseRows([...kept, ...added], 'export'),
            CONTRACT,
            'source_export',
            { pairResidualsByOrder: false },
          );

          // #then
          expect([
            summary.matchedIdenticalOccurrences + summary.missingOccurrences,
            summary.matchedIdenticalOccurrences + summary.excessOccurrences,
          ]).toEqual([summary.expectedRows, summary.observedRows]);
        },
      ),
    );
  });

  it('conserves counts with order pairing: matched + missing + changed = expected', () => {
    // #given
    fc.assert(
      fc.property(rowsArbitrary, rowsArbitrary, (expectedRows, observedRows) => {
        // #when
        const { summary } = compareArtifacts(
          parseRows(expectedRows, 'source'),
          parseRows(observedRows, 'export'),
          CONTRACT,
          'source_export',
        );

        // #then
        expect(
          summary.matchedIdenticalOccurrences + summary.missingOccurrences + summary.changedKeyCount,
        ).toBe(summary.expectedRows);
      }),
    );
  });

  it('is deterministic: the same bytes compared twice give deep-equal output', () => {
    // #given
    fc.assert(
      fc.property(rowsArbitrary, rowsArbitrary, (expectedRows, observedRows) => {
        const run = (): unknown =>
          compareArtifacts(
            parseRows(expectedRows, 'source'),
            parseRows(observedRows, 'export'),
            CONTRACT,
            'source_export',
          );

        // #when
        const [first, second] = [run(), run()];

        // #then
        expect(first).toEqual(second);
      }),
    );
  });

  it('gives equal decimals the same canonical text regardless of trailing zeros', () => {
    // #given a value and the same value padded with extra zeros
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.integer({ min: 0, max: 6 }),
        (cents, padding) => {
          const text = centsToText(cents);

          // #when
          const [plain, padded] = [
            canonicalDecimal(text, 2),
            canonicalDecimal(text + '0'.repeat(padding), 2),
          ];

          // #then
          expect(plain).toEqual(padded);
        },
      ),
    );
  });

  it('gives different decimals different canonical text', () => {
    // #given two distinct cent amounts
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), (a, b) => {
        fc.pre(a !== b);

        // #when
        const [left, right] = [canonicalDecimal(centsToText(a), 2), canonicalDecimal(centsToText(b), 2)];

        // #then
        expect(left.ok && right.ok && left.value !== right.value).toBe(true);
      }),
    );
  });
});
