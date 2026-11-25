import { type DataContract, DataContractSchema } from '@returntrip/contracts';
import { type ArtifactName, type ParsedArtifact, parseArtifact } from '../src/index.ts';

type FieldInput = Record<string, unknown> & { name: string; type: string };

export const DEFAULT_MAX_ROWS = 1_000_000;

export function makeContract(
  fields: readonly FieldInput[],
  overrides: Record<string, unknown> = {},
): DataContract {
  return DataContractSchema.parse({
    version: 1,
    encoding: 'utf8',
    identity: { mode: 'multiset' },
    fields,
    ...overrides,
  });
}

/** The demo contract for the City of Chicago payments sample (multiset, no unique key). */
export const PAYMENTS_CONTRACT = makeContract([
  { name: 'voucher_number', type: 'string', nullable: true, nullMarkers: [''] },
  { name: 'amount', type: 'decimal', scale: 2 },
  { name: 'check_date', type: 'date', formats: ['MM/DD/YYYY', 'YYYY'] },
  { name: 'department_name', type: 'string', nullable: true, nullMarkers: [''] },
  { name: 'contract_number', type: 'string' },
  { name: 'vendor_name', type: 'string' },
]);

/** Small keyed contract used by most comparison tests. */
export const LEDGER_CONTRACT = makeContract([
  { name: 'id', type: 'string' },
  { name: 'amount', type: 'decimal', scale: 2 },
]);

export const KEYED_LEDGER_CONTRACT = makeContract(
  [
    { name: 'id', type: 'string' },
    { name: 'amount', type: 'decimal', scale: 2 },
  ],
  { identity: { mode: 'uniqueKey', fields: ['id'] } },
);

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function parseText(
  text: string,
  contract: DataContract,
  artifact: ArtifactName = 'source',
  options: { maxRows?: number; maxFieldBytes?: number } = {},
): ParsedArtifact {
  return parseArtifact(bytes(text), contract, {
    artifact,
    maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
    ...(options.maxFieldBytes === undefined ? {} : { maxFieldBytes: options.maxFieldBytes }),
  });
}

/** RFC 4180 writer for building fixtures: quotes only cells that need it. */
export function toCsv(rows: readonly (readonly string[])[], lineEnding = '\n'): string {
  const encode = (cell: string): string => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  return rows.map((row) => row.map(encode).join(',')).join(lineEnding) + lineEnding;
}
