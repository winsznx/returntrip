import { formatCents } from '../domain/money.ts';

const COUNT_FORMAT = new Intl.NumberFormat('en-US');
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;
const MINUS_SIGN = '−';

export function formatCount(count: number, singular: string, plural: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? singular : plural}`;
}

/** Groups the exact decimal string rather than a float, so display never rounds. */
export function formatMoney(cents: bigint): string {
  const plain = formatCents(cents);
  const negative = plain.startsWith('-');
  const [whole = '0', fraction = '00'] = (negative ? plain.slice(1) : plain).split('.');
  return `${negative ? MINUS_SIGN : ''}$${whole.replace(THOUSANDS, ',')}.${fraction}`;
}

export function formatCreatedAt(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? isoTimestamp : DATE_FORMAT.format(date);
}
