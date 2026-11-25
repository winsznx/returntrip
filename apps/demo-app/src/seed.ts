/**
 * Loads a CSV straight into the database through db.ts.
 *
 * This is the trusted path for building a source workspace, so it deliberately shares no code
 * with src/import or src/csv: a defect in the importer must never leak into the reference data.
 * Its reader and mapping are kept small enough to check by eye.
 *
 *   node src/seed.ts --data-dir <dir> --workspace <slug> --name <name> --csv <path>
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openLedgerStore } from './db.ts';
import type { NewPayment } from './domain/payment.ts';
import { isValidSlug } from './domain/workspace.ts';

const COLUMNS = [
  'voucher_number',
  'amount',
  'check_date',
  'department_name',
  'contract_number',
  'vendor_name',
] as const;

type Column = (typeof COLUMNS)[number];

function main(): void {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      workspace: { type: 'string' },
      name: { type: 'string' },
      csv: { type: 'string' },
    },
    strict: true,
  });
  const dataDir = required(values['data-dir'], '--data-dir');
  const slug = required(values.workspace, '--workspace');
  const name = required(values.name, '--name').trim();
  const csvPath = required(values.csv, '--csv');
  if (!isValidSlug(slug)) {
    throw new Error(`--workspace must be lowercase letters, digits and single hyphens, got "${slug}"`);
  }
  if (name === '') {
    throw new Error('--name must not be blank');
  }

  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(csvPath));
  const payments = toPayments(readCsv(text));

  const store = openLedgerStore(dataDir);
  try {
    const created = store.createWorkspace({ slug, name });
    if (!created.ok) {
      throw new Error(`Workspace "${slug}" already exists in ${dataDir}`);
    }
    store.insertPayments(created.workspace.id, payments);
    console.log(`Seeded ${payments.length} payments into workspace "${slug}"`);
  } finally {
    store.close();
  }
}

function toPayments(rows: readonly string[][]): NewPayment[] {
  const [header, ...body] = rows;
  if (header === undefined) {
    throw new Error('CSV is empty');
  }
  const position = new Map(header.map((column, index) => [column, index]));
  for (const column of COLUMNS) {
    if (!position.has(column)) {
      throw new Error(`CSV header is missing column "${column}"`);
    }
  }

  return body.map((cells, index) => {
    const line = index + 2;
    if (cells.length !== header.length) {
      throw new Error(`Row ${line} has ${cells.length} fields, header has ${header.length}`);
    }
    const cell = (column: Column): string => cells[position.get(column) ?? -1] ?? '';
    const checkDate = cell('check_date');
    if (!isCheckDate(checkDate)) {
      throw new Error(`Row ${line}: check_date "${checkDate}" is not MM/DD/YYYY or YYYY`);
    }
    return {
      voucherNumber: cell('voucher_number') === '' ? null : cell('voucher_number'),
      amountCents: toCents(cell('amount'), line),
      checkDate,
      departmentName: cell('department_name') === '' ? null : cell('department_name'),
      contractNumber: cell('contract_number'),
      vendorName: cell('vendor_name'),
    };
  });
}

/** "17104.23" -> 1710423n, "-5.1" -> -510n, "19038" -> 1903800n. */
function toCents(amount: string, line: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (match === null) {
    throw new Error(`Row ${line}: amount "${amount}" is not a plain decimal with up to two places`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
}

function isCheckDate(value: string): boolean {
  if (/^\d{4}$/.test(value)) {
    return true;
  }
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (match === null) {
    return false;
  }
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // setUTCFullYear avoids Date.UTC's remapping of years 0-99 onto the 1900s.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Minimal RFC 4180 reader: quoted fields may hold commas, doubled quotes and line breaks. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (inQuotes) {
      if (char === '"' && text.charAt(index + 1) === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      if (field !== '') {
        throw new Error(`Quote inside an unquoted field: ${field}"`);
      }
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(index + 1) === '\n') {
        index++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (inQuotes) {
    throw new Error('CSV ends inside a quoted field');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${flag} is required`);
  }
  return value;
}

try {
  main();
} catch (error) {
  console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
