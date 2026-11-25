import { CsvParseError, parseCsv } from '../csv/parse.ts';
import type { LedgerStore } from '../db.ts';
import { isValidCheckDate } from '../domain/check-date.ts';
import { parseAmountCents } from '../domain/money.ts';
import { type NewPayment, PAYMENT_CSV_COLUMNS } from '../domain/payment.ts';

export type ImportOutcome =
  | { readonly ok: true; readonly imported: number }
  | { readonly ok: false; readonly error: string };

type RowOutcome =
  | { readonly ok: true; readonly payment: NewPayment }
  | { readonly ok: false; readonly error: string };

const EXPECTED_HEADER = PAYMENT_CSV_COLUMNS.join(',');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Validates the whole file before writing anything, then inserts all rows in a single
 * transaction, so a bad row anywhere leaves the workspace untouched.
 */
export function importPayments(store: LedgerStore, workspaceId: number, file: Uint8Array): ImportOutcome {
  const text = decodeUtf8(file);
  if (text === undefined) {
    return failure('The file is not UTF-8 text. Save it as "CSV UTF-8" and try again.');
  }

  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvParseError) {
      return failure(`The file is not valid CSV: ${error.message}.`);
    }
    throw error;
  }

  const [header, ...rows] = records;
  if (header === undefined) {
    return failure('The file is empty.');
  }
  const headerProblem = describeHeaderProblem(header);
  if (headerProblem !== undefined) {
    return failure(headerProblem);
  }

  const payments: NewPayment[] = [];
  for (const [index, cells] of rows.entries()) {
    if (isBlankLine(cells)) {
      continue;
    }
    // Spreadsheet numbering: the header is row 1, so the first payment is row 2.
    const row = toPayment(cells, index + 2);
    if (!row.ok) {
      return failure(row.error);
    }
    payments.push(row.payment);
  }

  if (payments.length === 0) {
    return failure('The file has a header but no payment rows.');
  }
  store.insertPayments(workspaceId, payments);
  return { ok: true, imported: payments.length };
}

function toPayment(cells: readonly string[], rowNumber: number): RowOutcome {
  if (cells.length !== PAYMENT_CSV_COLUMNS.length) {
    return {
      ok: false,
      error: `Row ${rowNumber} has ${cells.length} fields; expected ${PAYMENT_CSV_COLUMNS.length}.`,
    };
  }
  const [
    voucherNumber = '',
    amount = '',
    checkDate = '',
    departmentName = '',
    contractNumber = '',
    vendorName = '',
  ] = cells;

  const amountCents = parseAmountCents(amount);
  if (amountCents === undefined) {
    return {
      ok: false,
      error: `Row ${rowNumber}: amount "${amount}" is not valid. Use digits with up to two decimal places, like 1234.56.`,
    };
  }
  if (!isValidCheckDate(checkDate)) {
    return {
      ok: false,
      error: `Row ${rowNumber}: check date "${checkDate}" must be a real date written MM/DD/YYYY, or a four-digit year.`,
    };
  }

  return {
    ok: true,
    payment: {
      voucherNumber: emptyToNull(voucherNumber),
      amountCents,
      checkDate,
      departmentName: emptyToNull(departmentName),
      contractNumber,
      vendorName,
    },
  };
}

function describeHeaderProblem(header: readonly string[]): string | undefined {
  const expected: readonly string[] = PAYMENT_CSV_COLUMNS;
  if (header.length === expected.length && header.every((column, index) => column === expected[index])) {
    return undefined;
  }
  const missing = expected.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return `The header is missing ${listColumns(missing)}. Expected header: ${EXPECTED_HEADER}`;
  }
  const unexpected = header.filter((column) => !expected.includes(column));
  if (unexpected.length > 0) {
    return `The header has unexpected ${listColumns(unexpected)}. Expected header: ${EXPECTED_HEADER}`;
  }
  if (header.length !== expected.length) {
    return `The header repeats a column. Expected header: ${EXPECTED_HEADER}`;
  }
  return `The header columns are out of order. Expected header: ${EXPECTED_HEADER}`;
}

function listColumns(columns: readonly string[]): string {
  const quoted = columns.map((column) => `"${column}"`).join(', ');
  return columns.length === 1 ? `column ${quoted}` : `columns ${quoted}`;
}

function isBlankLine(cells: readonly string[]): boolean {
  return cells.length === 1 && cells[0] === '';
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}

function failure(error: string): ImportOutcome {
  return { ok: false, error };
}
