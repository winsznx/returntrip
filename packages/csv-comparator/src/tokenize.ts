import type { LineEndings } from './types.ts';

/*
 * Hand-written RFC 4180 reader instead of csv-parse: csv-parse 7 locks the record delimiter to the
 * first one it sees, so in a file that mixes CRLF and LF a later bare LF becomes part of a field
 * value instead of ending the record. A verdict engine cannot silently merge rows, and it also needs
 * the per-record terminators to report line endings, so the reader is owned here.
 */

const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

export interface RawRecord {
  readonly fields: readonly string[];
  /** 1-based physical line on which the record starts. */
  readonly line: number;
}

export interface TokenizeResult {
  readonly records: readonly RawRecord[];
  readonly lineEndings: LineEndings;
  /** Set when reading stopped early. Records before the failure are kept for diagnostics. */
  readonly failure: { readonly line: number; readonly message: string } | null;
  /** True when more than `maxRecords` records exist; reading stops after `maxRecords`. */
  readonly truncated: boolean;
}

/**
 * Splits text into records. A terminator at end of input does not open another record; every other
 * line, blank ones included, is a record, so blank lines surface as width errors rather than vanishing.
 */
export function tokenize(text: string, delimiter: string, maxRecords: number): TokenizeResult {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new RangeError(`unsupported delimiter ${JSON.stringify(delimiter)}`);
  }
  const delimiterCode = delimiter.charCodeAt(0);
  const length = text.length;
  const records: RawRecord[] = [];
  let crlfCount = 0;
  let lfCount = 0;
  let line = 1;
  let recordLine = 1;
  let fields: string[] = [];
  let index = 0;

  const finish = (failure: TokenizeResult['failure'], truncated = false): TokenizeResult => ({
    records,
    lineEndings: crlfCount > 0 ? (lfCount > 0 ? 'mixed' : 'crlf') : lfCount > 0 ? 'lf' : 'none',
    failure,
    truncated,
  });

  if (length === 0) return finish(null);

  for (;;) {
    if (index < length && text.charCodeAt(index) === QUOTE) {
      const openedOnLine = line;
      let value = '';
      let segmentStart = ++index;
      for (;;) {
        if (index >= length) {
          return finish({
            line: openedOnLine,
            message: `quoted field opened on line ${openedOnLine} is never closed`,
          });
        }
        const code = text.charCodeAt(index);
        if (code === QUOTE) {
          if (text.charCodeAt(index + 1) === QUOTE) {
            value += text.slice(segmentStart, index + 1);
            index += 2;
            segmentStart = index;
            continue;
          }
          value += text.slice(segmentStart, index);
          index++;
          break;
        }
        if (code === LF) line++;
        index++;
      }
      fields.push(value);
      if (index < length) {
        const next = text.charCodeAt(index);
        if (next !== delimiterCode && next !== CR && next !== LF) {
          return finish({ line, message: `unexpected text after a closing quote on line ${line}` });
        }
      }
    } else {
      const start = index;
      while (index < length) {
        const code = text.charCodeAt(index);
        if (code === delimiterCode || code === CR || code === LF) break;
        if (code === QUOTE) {
          return finish({ line, message: `quote inside an unquoted field on line ${line}` });
        }
        index++;
      }
      fields.push(text.slice(start, index));
    }

    if (index >= length) {
      if (records.length === maxRecords) return finish(null, true);
      records.push({ fields, line: recordLine });
      return finish(null);
    }
    const code = text.charCodeAt(index);
    if (code === delimiterCode) {
      index++;
      continue;
    }
    if (code === CR) {
      if (text.charCodeAt(index + 1) !== LF) {
        return finish({ line, message: `carriage return without line feed on line ${line}` });
      }
      crlfCount++;
      index += 2;
    } else {
      lfCount++;
      index++;
    }
    line++;
    if (records.length === maxRecords) return finish(null, true);
    records.push({ fields, line: recordLine });
    if (index >= length) return finish(null);
    fields = [];
    recordLine = line;
  }
}
