import type { Difference } from '@returntrip/contracts';

const COLUMNS = [
  'id',
  'edge',
  'kind',
  'key',
  'field',
  'expected_raw',
  'observed_raw',
  'expected_canonical',
  'observed_canonical',
  'expected_count',
  'observed_count',
  'expected_rows',
  'observed_rows',
  'message',
] as const;

/** Leading characters that make Excel, Sheets or LibreOffice evaluate a cell as a formula. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Derivative export of a difference report for opening in a spreadsheet. Formula-like cells get a
 * leading apostrophe and nulls render as empty cells, so this view is lossy: never use it as evidence.
 */
export function toSpreadsheetSafeCsv(differences: readonly Difference[]): string {
  const lines = [COLUMNS.join(',')];
  for (const difference of differences) {
    const cells: Record<(typeof COLUMNS)[number], string> = {
      id: difference.id,
      edge: difference.edge,
      kind: difference.kind,
      key: difference.key ? JSON.stringify(difference.key) : '',
      field: difference.field ?? '',
      expected_raw: difference.expectedRaw ?? '',
      observed_raw: difference.observedRaw ?? '',
      expected_canonical: difference.expectedCanonical ?? '',
      observed_canonical: difference.observedCanonical ?? '',
      expected_count: difference.expectedCount?.toString() ?? '',
      observed_count: difference.observedCount?.toString() ?? '',
      expected_rows: difference.expectedRowRefs.join(' '),
      observed_rows: difference.observedRowRefs.join(' '),
      message: difference.message,
    };
    lines.push(COLUMNS.map((column) => encodeCell(cells[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function encodeCell(value: string): string {
  const neutralized = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(neutralized) ? `"${neutralized.replaceAll('"', '""')}"` : neutralized;
}
