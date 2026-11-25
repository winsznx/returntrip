// Builds source.csv and provenance.json from the archived City of Chicago Payments API response.
// Usage: node examples/payment-roundtrip/scripts/prepare-source.ts [--from <local json>]
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DATASET_URL = 'https://data.cityofchicago.org/resource/s4vu-giwb.json';
const SNAPSHOT_TIMESTAMP = '20261109180553';
const ARCHIVE_URL = `https://web.archive.org/web/${SNAPSHOT_TIMESTAMP}id_/${DATASET_URL}`;
const COLUMNS = [
  'voucher_number',
  'amount',
  'check_date',
  'department_name',
  'contract_number',
  'vendor_name',
] as const;
const EXPECTED_ROWS = 1000;

type Column = (typeof COLUMNS)[number];
type SourceRecord = Partial<Record<Column | 'cashed', unknown>>;

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function requireString(record: SourceRecord, column: Column, index: number): string {
  const value = record[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`row ${index + 1}: required column ${column} is missing`);
  }
  return value;
}

function optionalString(record: SourceRecord, column: Column, index: number): string {
  const value = record[column];
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`row ${index + 1}: ${column} is not a string`);
  return value;
}

function toRow(record: SourceRecord, index: number): string[] {
  const amount = requireString(record, 'amount', index);
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) throw new Error(`row ${index + 1}: unexpected amount ${amount}`);
  const checkDate = requireString(record, 'check_date', index);
  if (!/^(\d{2}\/\d{2}\/\d{4}|\d{4})$/.test(checkDate)) {
    throw new Error(`row ${index + 1}: unexpected check_date ${checkDate}`);
  }
  return [
    optionalString(record, 'voucher_number', index),
    amount,
    checkDate,
    optionalString(record, 'department_name', index),
    requireString(record, 'contract_number', index),
    requireString(record, 'vendor_name', index),
  ];
}

async function loadRaw(from: string | undefined): Promise<{ bytes: Uint8Array; retrievedFrom: string }> {
  if (from) return { bytes: await readFile(from), retrievedFrom: `local file ${from}` };
  const response = await fetch(ARCHIVE_URL);
  if (!response.ok) throw new Error(`archive returned HTTP ${response.status}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), retrievedFrom: ARCHIVE_URL };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { from: { type: 'string' } } });
  const { bytes, retrievedFrom } = await loadRaw(values.from);
  const records: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(records) || records.length !== EXPECTED_ROWS) {
    throw new Error(`expected an array of ${EXPECTED_ROWS} records`);
  }

  const rows = (records as SourceRecord[]).map(toRow);
  const csv = `${[COLUMNS.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n')}\r\n`;

  const tupleCounts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    tupleCounts.set(key, (tupleCounts.get(key) ?? 0) + 1);
  }
  const duplicateGroups = [...tupleCounts.values()].filter((count) => count > 1);

  await writeFile(join(exampleDir, 'source.csv'), csv);
  const provenance = {
    dataset: 'City of Chicago, Payments (s4vu-giwb)',
    datasetPage: 'https://data.cityofchicago.org/Administration-Finance/Payments/s4vu-giwb',
    officialApi: DATASET_URL,
    archivedResponse: `https://web.archive.org/web/${SNAPSHOT_TIMESTAMP}/${DATASET_URL}`,
    archiveCapturedAt: '2026-11-09T18:05:53Z',
    retrievedFrom,
    retrievedAt: new Date().toISOString(),
    selection:
      'Default first page of the official API (no filter, no ordering parameter), all 1,000 rows kept in order.',
    rawSha256: sha256(bytes),
    transformation:
      'JSON records written as CSV in column order voucher_number, amount, check_date, department_name, contract_number, vendor_name. Values copied verbatim; absent keys written as empty cells. The cashed field is absent from every record and is dropped.',
    output: {
      file: 'source.csv',
      rows: rows.length,
      sha256: sha256(csv),
      duplicateTupleGroups: duplicateGroups.length,
    },
    identity:
      'No unique key: voucher_number is empty in some rows and repeats in others, and some rows are fully identical. Compared as a multiset.',
    terms: 'https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html',
    disclaimer:
      'This site provides applications using data that has been modified for use from its original source, www.cityofchicago.org, the official website of the City of Chicago. The City of Chicago makes no claims as to the content, accuracy, timeliness, or completeness of any of the data provided at this site. The data provided at this site is subject to change at any time. It is understood that the data provided at this site is being used at one’s own risk.',
  };
  await writeFile(join(exampleDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(
    `source.csv: ${rows.length} rows, sha256 ${provenance.output.sha256}, ${duplicateGroups.length} identical-row groups\n`,
  );
}

await main();
