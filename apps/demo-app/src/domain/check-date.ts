const FULL_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const YEAR_ONLY = /^\d{4}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Accepts a real calendar date written MM/DD/YYYY, or a bare four-digit year for annual summary rows. */
export function isValidCheckDate(text: string): boolean {
  if (YEAR_ONLY.test(text)) {
    return true;
  }
  const match = FULL_DATE.exec(text);
  if (match === null) {
    return false;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
