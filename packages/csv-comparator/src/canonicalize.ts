import type { FieldSpec } from '@returntrip/contracts';

export type CellResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly message: string };

export type CellCanonicalizer = (raw: string) => CellResult;

type DateFormat = NonNullable<FieldSpec['formats']>[number];

/** PRD 8.1 default numeric precision bound. */
const MAX_NUMERIC_DIGITS = 100;
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const INTEGER_PATTERN = /^-?\d+$/;
const QUOTED_VALUE_PREVIEW = 80;

const DATE_PATTERNS: Readonly<
  Record<DateFormat, { pattern: RegExp; year: number; month: number; day: number }>
> = {
  'YYYY-MM-DD': { pattern: /^(\d{4})-(\d{2})-(\d{2})$/, year: 1, month: 2, day: 3 },
  'MM/DD/YYYY': { pattern: /^(\d{2})\/(\d{2})\/(\d{4})$/, year: 3, month: 1, day: 2 },
  'DD/MM/YYYY': { pattern: /^(\d{2})\/(\d{2})\/(\d{4})$/, year: 3, month: 2, day: 1 },
  YYYY: { pattern: /^(\d{4})$/, year: 1, month: 0, day: 0 },
};

export function quoteValue(value: string): string {
  const preview = value.length > QUOTED_VALUE_PREVIEW ? `${value.slice(0, QUOTED_VALUE_PREVIEW)}…` : value;
  return JSON.stringify(preview);
}

const ok = (value: string | null): CellResult => ({ ok: true, value });
const fail = (message: string): CellResult => ({ ok: false, message });

/**
 * Builds the canonicalizer for one declared field. Throws for contracts that skipped schema
 * validation (a date without formats, a boolean without lexemes): that is a programmer error, not data.
 */
export function createCellCanonicalizer(field: FieldSpec): CellCanonicalizer {
  const parseTyped = createTypedParser(field);
  const nullMarkers = new Set(field.nullMarkers);
  return (raw) => {
    const value = field.trim ? raw.trim() : raw;
    if (nullMarkers.has(value)) {
      return field.nullable ? ok(null) : fail(`null marker ${quoteValue(value)} in a non-nullable field`);
    }
    return parseTyped(value);
  };
}

function createTypedParser(field: FieldSpec): CellCanonicalizer {
  switch (field.type) {
    case 'string':
      return field.unicodeNormalization === 'NFC' ? (value) => ok(value.normalize('NFC')) : ok;
    case 'decimal':
      return (value) => canonicalDecimal(value, field.scale);
    case 'integer':
      return canonicalInteger;
    case 'date': {
      const formats = field.formats;
      if (!formats || formats.length === 0) {
        throw new Error(`date field "${field.name}" declares no formats; validate the contract first`);
      }
      return (value) => canonicalDate(value, formats);
    }
    case 'boolean': {
      if (!field.trueValues || !field.falseValues) {
        throw new Error(`boolean field "${field.name}" declares no lexemes; validate the contract first`);
      }
      const trueValues = new Set(field.trueValues);
      const falseValues = new Set(field.falseValues);
      return (value) => {
        if (trueValues.has(value)) return ok('true');
        if (falseValues.has(value)) return ok('false');
        return fail(`${quoteValue(value)} is not a declared boolean value`);
      };
    }
  }
}

/**
 * Canonical form is exact digit text: no leading zeros, trailing zeros trimmed, padded to the
 * declared scale when there is one, and negative zero folded to zero. Equal numbers therefore get
 * identical strings without ever passing through binary floating point.
 */
export function canonicalDecimal(value: string, scale: number | undefined): CellResult {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return fail(`${quoteValue(value)} is not a plain decimal`);
  const sign = match[1] ?? '';
  const integerDigits = match[2] ?? '';
  const fractionDigits = match[3] ?? '';
  if (integerDigits.length + fractionDigits.length > MAX_NUMERIC_DIGITS) {
    return fail(`${quoteValue(value)} has more than ${MAX_NUMERIC_DIGITS} digits`);
  }
  const significantFraction = fractionDigits.replace(/0+$/, '');
  if (scale !== undefined && significantFraction.length > scale) {
    return fail(`${quoteValue(value)} has non-zero digits beyond scale ${scale}`);
  }
  const integer = integerDigits.replace(/^0+(?=\d)/, '');
  const isZero = integer === '0' && significantFraction === '';
  const fraction = scale === undefined ? significantFraction : significantFraction.padEnd(scale, '0');
  return ok(`${isZero ? '' : sign}${integer}${fraction ? `.${fraction}` : ''}`);
}

export function canonicalInteger(value: string): CellResult {
  if (!INTEGER_PATTERN.test(value)) return fail(`${quoteValue(value)} is not an integer`);
  if (value.replace('-', '').length > MAX_NUMERIC_DIGITS) {
    return fail(`${quoteValue(value)} has more than ${MAX_NUMERIC_DIGITS} digits`);
  }
  return ok(BigInt(value).toString());
}

/** Formats are tried in declared order; the first that yields a real calendar date wins. */
export function canonicalDate(value: string, formats: readonly DateFormat[]): CellResult {
  for (const format of formats) {
    const spec = DATE_PATTERNS[format];
    const match = spec.pattern.exec(value);
    if (!match) continue;
    const yearText = match[spec.year] ?? '';
    const year = Number(yearText);
    if (year < 1) continue;
    if (format === 'YYYY') return ok(yearText);
    const monthText = match[spec.month] ?? '';
    const dayText = match[spec.day] ?? '';
    if (isCalendarDate(year, Number(monthText), Number(dayText))) {
      return ok(`${yearText}-${monthText}-${dayText}`);
    }
  }
  return fail(`${quoteValue(value)} is not a valid date in format ${formats.join(' or ')}`);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
