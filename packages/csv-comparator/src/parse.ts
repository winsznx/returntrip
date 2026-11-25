import type { ArtifactSchemaError, DataContract } from '@returntrip/contracts';
import { type CellCanonicalizer, createCellCanonicalizer, quoteValue } from './canonicalize.ts';
import { canonicalContractHash, sha256Hex } from './hash.ts';
import { type RawRecord, tokenize } from './tokenize.ts';
import type { CanonicalRow, LineEndings, ParsedArtifact, ParseOptions } from './types.ts';

const DEFAULT_MAX_FIELD_BYTES = 64 * 1024;
/** UTF-8 never spends more than 3 bytes on one UTF-16 code unit, so shorter strings skip the byte count. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

interface DeclaredColumn {
  readonly name: string;
  readonly position: number;
  readonly canonicalize: CellCanonicalizer;
}

interface ColumnLayout {
  /** Declared fields in declared order, each with its header position. */
  readonly columns: readonly DeclaredColumn[];
  readonly errors: readonly { readonly column: string | null; readonly message: string }[];
}

/**
 * Parses and canonicalizes one artifact. Data defects become `schemaErrors` and never throw;
 * invalid options or an unvalidated contract throw because they are caller bugs.
 */
export function parseArtifact(
  bytes: Uint8Array,
  contract: DataContract,
  options: ParseOptions,
): ParsedArtifact {
  assertPositiveInteger('maxRows', options.maxRows);
  const maxFieldBytes = options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  assertPositiveInteger('maxFieldBytes', maxFieldBytes);
  const fieldCanonicalizers = contract.fields.map((field) => ({
    name: field.name,
    canonicalize: createCellCanonicalizer(field),
  }));

  const artifact = options.artifact;
  const schemaErrors: ArtifactSchemaError[] = [];
  const report = (row: number | null, column: string | null, message: string): void => {
    schemaErrors.push({ artifact, row, column, message });
  };
  const bom = hasUtf8Bom(bytes);
  const base = {
    artifact,
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    bom,
    contractHash: canonicalContractHash(contract),
    schemaErrors,
  };
  const incomparable = (
    header: readonly string[],
    lineEndings: LineEndings,
    rowCount: number,
    rows: readonly CanonicalRow[],
    invalidRowCount: number,
  ): ParsedArtifact => ({ ...base, header, lineEndings, rowCount, rows, invalidRowCount, comparable: false });

  const text = decodeUtf8(bom ? bytes.subarray(3) : bytes);
  if (text === null) {
    report(null, null, 'artifact is not valid UTF-8');
    return incomparable([], 'none', 0, [], 0);
  }

  const tokens = tokenize(text, contract.delimiter, options.maxRows + 1);
  const [headerRecord, ...dataRecords] = tokens.records;
  if (!headerRecord) {
    report(null, null, tokens.failure?.message ?? 'artifact is empty; a header row is required');
    return incomparable([], tokens.lineEndings, 0, [], 0);
  }

  const header = headerRecord.fields;
  const layout = resolveColumns(header, contract, fieldCanonicalizers);
  for (const error of layout.errors) report(null, error.column, error.message);
  if (layout.errors.length > 0) {
    return incomparable(header, tokens.lineEndings, dataRecords.length, [], 0);
  }

  const rows: CanonicalRow[] = [];
  let invalidRowCount = 0;
  dataRecords.forEach((record, index) => {
    const rowNumber = index + 1;
    const row = readRow(record, rowNumber, header, layout.columns, maxFieldBytes, report);
    if (row) rows.push(row);
    else invalidRowCount++;
  });

  if (tokens.failure) {
    const failedRow = dataRecords.length + 1;
    report(failedRow, null, `${tokens.failure.message}; reading stopped at data row ${failedRow}`);
  }
  if (tokens.truncated) {
    report(null, null, `artifact has more than ${options.maxRows} data rows`);
  }
  if (tokens.failure || tokens.truncated) {
    return incomparable(header, tokens.lineEndings, dataRecords.length, rows, invalidRowCount);
  }
  return {
    ...base,
    header,
    lineEndings: tokens.lineEndings,
    rowCount: dataRecords.length,
    rows,
    invalidRowCount,
    comparable: true,
  };
}

function readRow(
  record: RawRecord,
  rowNumber: number,
  header: readonly string[],
  columns: readonly DeclaredColumn[],
  maxFieldBytes: number,
  report: (row: number, column: string | null, message: string) => void,
): CanonicalRow | null {
  const { fields } = record;
  if (fields.length !== header.length) {
    const blank = fields.length === 1 && fields[0] === '';
    report(
      rowNumber,
      null,
      blank
        ? `blank line ${record.line}; expected ${header.length} fields`
        : `row on line ${record.line} has ${fields.length} fields; header has ${header.length}`,
    );
    return null;
  }

  let valid = true;
  for (const [position, value] of fields.entries()) {
    if (
      value.length * MAX_UTF8_BYTES_PER_CODE_UNIT > maxFieldBytes &&
      Buffer.byteLength(value, 'utf8') > maxFieldBytes
    ) {
      report(rowNumber, header[position] ?? null, `field exceeds ${maxFieldBytes} bytes`);
      valid = false;
    }
  }
  if (!valid) return null;

  const raw: [string, string][] = [];
  const canonical: (string | null)[] = [];
  for (const column of columns) {
    const value = fields[column.position] ?? '';
    raw.push([column.name, value]);
    const result = column.canonicalize(value);
    if (result.ok) {
      canonical.push(result.value);
    } else {
      report(rowNumber, column.name, result.message);
      valid = false;
    }
  }
  if (!valid) return null;
  return { rowNumber, raw: Object.fromEntries(raw), canonical, tupleKey: JSON.stringify(canonical) };
}

function resolveColumns(
  header: readonly string[],
  contract: DataContract,
  fieldCanonicalizers: readonly { readonly name: string; readonly canonicalize: CellCanonicalizer }[],
): ColumnLayout {
  const errors: { column: string | null; message: string }[] = [];
  const seen = new Set<string>();
  const reportedDuplicates = new Set<string>();
  for (const name of header) {
    if (seen.has(name) && !reportedDuplicates.has(name)) {
      errors.push({ column: name, message: `duplicate header ${quoteValue(name)}` });
      reportedDuplicates.add(name);
    }
    seen.add(name);
  }

  const columns = fieldCanonicalizers.map((field) => ({ ...field, position: header.indexOf(field.name) }));
  for (const column of columns) {
    if (column.position === -1) {
      errors.push({ column: column.name, message: `missing declared header ${quoteValue(column.name)}` });
    }
  }

  if (contract.extraColumns === 'reject') {
    const declared = new Set(contract.fields.map((field) => field.name));
    const ignored = new Set(contract.ignoredColumns);
    for (const name of new Set(header)) {
      if (!declared.has(name) && !ignored.has(name)) {
        errors.push({ column: name, message: `unexpected column ${quoteValue(name)}` });
      }
    }
  }
  return { columns, errors };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}
