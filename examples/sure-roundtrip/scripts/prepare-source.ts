// Builds source.csv for Sure from the Chicago payments source, in Sure's transactions.csv layout.
// Usage: node examples/sure-roundtrip/scripts/prepare-source.ts [--rows 250]
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const chicagoSource = join(exampleDir, '..', 'payment-roundtrip', 'source.csv');
const HEADER = ['date', 'account_name', 'amount', 'name', 'category', 'tags', 'notes', 'currency'];

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Minimal RFC 4180 reader for the known, already-validated Chicago source. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  return rows;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rows: { type: 'string', default: '250' } } });
  const limit = Number(values.rows);
  const sourceBytes = await readFile(chicagoSource);
  const [header, ...records] = readCsv(sourceBytes.toString('utf8'));
  if (!header) throw new Error('Chicago source has no header');
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`missing column ${name}`);
    return index;
  };
  const [amountAt, dateAt, vendorAt] = [column('amount'), column('check_date'), column('vendor_name')];

  const out: string[][] = [];
  for (const record of records) {
    if (out.length >= limit) break;
    const date = record[dateAt] ?? '';
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    if (!match) continue;
    const [, month, day, year] = match;
    out.push([
      `${year}-${month}-${day}`,
      'Everyday Checking',
      record[amountAt] ?? '',
      record[vendorAt] ?? '',
      '',
      '',
      `rt-${String(out.length + 1).padStart(4, '0')}`,
      'USD',
    ]);
  }
  const csv = `${[HEADER, ...out].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
  await writeFile(join(exampleDir, 'source.csv'), csv);
  const provenance = {
    derivedFrom: '../payment-roundtrip/source.csv (City of Chicago Payments, see its provenance.json)',
    derivedFromSha256: sha256(sourceBytes),
    selection: `First ${out.length} payments whose check_date is a full MM/DD/YYYY date, in file order. Year-only rolled-up rows are skipped because Sure needs a calendar date.`,
    transformation:
      "Written in Sure's transactions.csv export layout: date as YYYY-MM-DD, account_name 'Everyday Checking', amount as published (positive = money out, Sure's stored convention), name = vendor_name, empty category and tags, notes = rt-NNNN so every row has a unique key, currency USD.",
    output: { file: 'source.csv', rows: out.length, sha256: sha256(csv) },
  };
  await writeFile(join(exampleDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`source.csv: ${out.length} rows, sha256 ${provenance.output.sha256}\n`);
}

await main();
