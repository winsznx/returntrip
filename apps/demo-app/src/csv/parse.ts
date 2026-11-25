export class CsvParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} on line ${line}`);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

/**
 * Strict RFC 4180 parser. Records end at CRLF, LF or a lone CR; quoted fields may contain
 * delimiters, line breaks and doubled quotes. A quote anywhere else is a syntax error
 * rather than something to guess around.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterClosingQuote = false;
  let line = 1;
  let quoteOpenedOnLine = 1;

  const endField = (): void => {
    record.push(field);
    field = '';
    afterClosingQuote = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);

    if (inQuotes) {
      if (char !== '"') {
        if (char === '\n') {
          line++;
        }
        field += char;
      } else if (text.charAt(index + 1) === '"') {
        field += '"';
        index++;
      } else {
        inQuotes = false;
        afterClosingQuote = true;
      }
      continue;
    }

    switch (char) {
      case ',':
        endField();
        break;
      case '\r':
        if (text.charAt(index + 1) === '\n') {
          index++;
        }
        endRecord();
        line++;
        break;
      case '\n':
        endRecord();
        line++;
        break;
      case '"':
        if (field !== '' || afterClosingQuote) {
          throw new CsvParseError('Unexpected quote inside an unquoted field', line);
        }
        inQuotes = true;
        quoteOpenedOnLine = line;
        break;
      default:
        if (afterClosingQuote) {
          throw new CsvParseError('Unexpected text after a closing quote', line);
        }
        field += char;
    }
  }

  if (inQuotes) {
    throw new CsvParseError('Quoted field is never closed', quoteOpenedOnLine);
  }
  if (field !== '' || afterClosingQuote || record.length > 0) {
    endRecord();
  }
  return records;
}
