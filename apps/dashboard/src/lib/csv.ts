export interface CsvTable {
  readonly header: readonly string[];
  /** Data rows only; row ref N (1-based, header excluded) is rows[N - 1]. */
  readonly rows: readonly (readonly string[])[];
}

/**
 * RFC 4180 reader for display only: quoted fields, doubled quotes, embedded line breaks, CRLF.
 * The comparator, never this, decides equality; this only shows the bytes a row ref points at.
 */
export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      index++;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') endField();
    else if (char === '\n') endRecord();
    else if (char === '\r') {
      if (text[index + 1] === '\n') index++;
      endRecord();
    } else field += char;
    index++;
  }
  if (field !== '' || record.length > 0) endRecord();

  const [header = [], ...rows] = records;
  return { header, rows };
}
