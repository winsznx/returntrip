import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv/parse.ts';
import { EXPECTED_SOURCE_EXPORT, FIXTURE_PAYMENT_COUNT } from './support/expected.ts';
import { copyApp, type RoundTrip, removeTempDirs, runRoundTrip } from './support/ledgerline.ts';

type Records = readonly (readonly string[])[];

interface DefectCase {
  readonly patch: string;
  readonly importedCount: number;
  /** Derives the corrupted re-export from the source export's payment rows. */
  readonly corrupt: (rows: Records) => Records;
}

const AMOUNT = 1;
const DEPARTMENT = 3;
const VENDOR = 5;

const withColumn = (row: readonly string[], column: number, value: string): string[] =>
  row.with(column, value);

const DEFECTS: readonly DefectCase[] = [
  {
    patch: 'sign-flip.patch',
    importedCount: FIXTURE_PAYMENT_COUNT,
    corrupt: (rows) =>
      rows.map((row) => {
        const amount = row[AMOUNT] ?? '';
        return withColumn(row, AMOUNT, amount.startsWith('-') ? amount.slice(1) : `-${amount}`);
      }),
  },
  {
    patch: 'comma-split.patch',
    importedCount: FIXTURE_PAYMENT_COUNT,
    corrupt: (rows) =>
      rows.map((row) => {
        const vendor = row[VENDOR] ?? '';
        const naive: Readonly<Record<string, string>> = {
          'ACME WASTE, INC.': 'ACME WASTE',
          'Smith "Bros" Hauling LLC': 'Smith ""Bros"" Hauling LLC',
          'North Shore Books\nAnnex': 'North Shore Books',
        };
        return withColumn(row, VENDOR, naive[vendor] ?? vendor);
      }),
  },
  {
    patch: 'drop-duplicates.patch',
    importedCount: FIXTURE_PAYMENT_COUNT - 1,
    corrupt: (rows) => {
      const seen = new Set<string>();
      return rows.filter((row) => {
        const key = JSON.stringify(row);
        const duplicate = seen.has(key);
        seen.add(key);
        return !duplicate;
      });
    },
  },
  {
    patch: 'cents-truncation.patch',
    importedCount: FIXTURE_PAYMENT_COUNT,
    corrupt: (rows) =>
      rows.map((row) => {
        const [whole = ''] = (row[AMOUNT] ?? '').split('.');
        return withColumn(row, AMOUNT, `${whole === '-0' ? '0' : whole}.00`);
      }),
  },
  {
    patch: 'column-order.patch',
    importedCount: FIXTURE_PAYMENT_COUNT,
    corrupt: (rows) =>
      rows.map((row) =>
        withColumn(withColumn(row, DEPARTMENT, row[VENDOR] ?? ''), VENDOR, row[DEPARTMENT] ?? ''),
      ),
  },
];

const [EXPECTED_HEADER = [], ...SOURCE_ROWS] = parseCsv(EXPECTED_SOURCE_EXPORT);

afterAll(() => {
  removeTempDirs();
});

describe.each(DEFECTS)('defect $patch', ({ patch, importedCount, corrupt }) => {
  let roundTrip: RoundTrip;

  beforeAll(async () => {
    roundTrip = await runRoundTrip(copyApp(patch));
  }, 30_000);

  it('leaves the export of the seeded source untouched', () => {
    // #given a patched app whose source workspace came from the independent seed path
    // #when the source workspace is exported
    const { sourceExport } = roundTrip;
    // #then the reference data is still correct, so only the import path is broken
    expect(sourceExport).toBe(EXPECTED_SOURCE_EXPORT);
  });

  it('still reports a successful import, so the UI alone cannot reveal it', () => {
    // #given the source export uploaded into a new workspace on the patched app
    // #when the landing page banner is read
    const banner = /<div[^>]*role="status"[^>]*>([^<]*)<\/div>/.exec(roundTrip.restoredPage)?.[1];
    // #then it claims success for the number of rows the defect kept
    expect(banner).toBe(`Import successful: ${importedCount} payments`);
  });

  it('corrupts the re-exported data in the way this bug class does', () => {
    // #given the payment rows the source export contained
    const expected = [EXPECTED_HEADER, ...corrupt(SOURCE_ROWS)];
    // #when the restored workspace's export is parsed
    const actual = parseCsv(roundTrip.restoredExport);
    // #then it differs from the source exactly as the defect predicts
    expect(actual).toEqual(expected);
  });
});
