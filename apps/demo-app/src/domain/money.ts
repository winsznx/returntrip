const AMOUNT_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const MAX_CENTS = 2n ** 63n - 1n;

/**
 * Parses an amount such as "19038", "-5.1" or "17104.23" into integer cents.
 * Uses string and BigInt arithmetic so no value ever passes through a float.
 * Returns undefined for anything that is not a plain decimal or that overflows SQLite's INTEGER.
 */
export function parseAmountCents(text: string): bigint | undefined {
  const match = AMOUNT_PATTERN.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, sign, whole = '', fraction = ''] = match;
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (magnitude > MAX_CENTS) {
    return undefined;
  }
  return sign === '-' ? -magnitude : magnitude;
}

/** Formats integer cents as a plain decimal with exactly two fraction digits, e.g. "-5.10". */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
