const NEEDS_QUOTING = /[",\r\n]/;

export function formatCsvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serializes records per RFC 4180, terminating every record (including the last) with CRLF. */
export function formatCsv(records: readonly (readonly string[])[]): string {
  return records.map((record) => `${record.map(formatCsvField).join(',')}\r\n`).join('');
}
