/** Thousands separators without Intl, so the dashboard prints numbers exactly like the CLI. */
export function formatCount(value: number): string {
  const [whole = '0', fraction] = String(Math.abs(value)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** Kane reports fractional credits; one decimal is what a person compares against a cap. */
export function formatCredits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  return formatCount(Math.round(value * 10) / 10);
}

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  return `$${value.toFixed(2)}`;
}

/** "42 s", "5 min 31 s", "1 h 2 min". Never rounds a non-zero duration down to nothing. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.max(Math.round(ms), 0)} ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}

/** Elapsed clock for timelines: m:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function shortHash(sha256: string | null, length = 12): string {
  return sha256 ? sha256.slice(0, length) : 'none';
}

/** Numerator over denominator, the only way the dashboard shows preservation. */
export function formatRatio(numerator: number, denominator: number): string {
  return `${formatCount(numerator)} / ${formatCount(denominator)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "25 Nov 2026" in UTC, so a recorded run carries the same date for every reader. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "25 Nov 2026, 18:33 UTC". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(iso)}, ${hh}:${mm} UTC`;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${formatCount(count)} ${count === 1 ? noun : pluralNoun}`;
}
