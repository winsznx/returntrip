import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatCount,
  formatCredits,
  formatDate,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatRatio,
  formatUsd,
  plural,
} from '../src/lib/format.ts';

describe('number formatting', () => {
  it('groups thousands without touching decimals or the sign', () => {
    // #given
    const values = [0, 999, 1000, 1234567, -17104.23, 1000.5];
    // #when
    const text = values.map(formatCount);
    // #then
    expect(text).toEqual(['0', '999', '1,000', '1,234,567', '-17,104.23', '1,000.5']);
  });

  it('rounds Kane credits to one decimal and says unknown for missing values', () => {
    // #given
    const values = [76.07809, 130.548515, 18, null, Number.NaN];
    // #when
    const text = values.map(formatCredits);
    // #then
    expect(text).toEqual(['76.1', '130.5', '18', 'unknown', 'unknown']);
  });

  it('shows preservation as a ratio, never a bare percent', () => {
    // #given
    const pairs: [number, number][] = [
      [1000, 1000],
      [0, 1000],
      [12345, 50000],
    ];
    // #when
    const text = pairs.map(([numerator, denominator]) => formatRatio(numerator, denominator));
    // #then
    expect(text).toEqual(['1,000 / 1,000', '0 / 1,000', '12,345 / 50,000']);
    expect(text.join(' ')).not.toContain('%');
  });

  it('formats durations, elapsed clocks, bytes and money', () => {
    // #given
    const durations = [450, 42_000, 331_029, 120_000, 3_725_000, null];
    // #when
    const text = durations.map(formatDuration);
    // #then
    expect(text).toEqual(['450 ms', '42 s', '5 min 31 s', '2 min', '1 h 2 min', 'unknown']);
    expect([formatElapsed(51), formatElapsed(330_978), formatElapsed(3_725_000)]).toEqual([
      '0:00',
      '5:30',
      '1:02:05',
    ]);
    expect([formatBytes(242), formatBytes(72_291), formatBytes(1_046_355), formatBytes(2_097_152)]).toEqual([
      '242 B',
      '70.6 KiB',
      '1021.8 KiB',
      '2.0 MiB',
    ]);
    expect([formatUsd(0.191436), formatUsd(null)]).toEqual(['$0.19', 'unknown']);
  });

  it('prints dates in UTC so every reader sees the recorded date', () => {
    // #given
    const iso = '2026-11-25T23:59:00.000Z';
    // #when
    const text = [formatDate(iso), formatDateTime(iso)];
    // #then
    expect(text).toEqual(['25 Nov 2026', '25 Nov 2026, 23:59 UTC']);
  });

  it('pluralizes with grouped counts', () => {
    // #given
    const counts = [1, 2, 1000];
    // #when
    const text = counts.map((count) => plural(count, 'miss', 'misses'));
    // #then
    expect(text).toEqual(['1 miss', '2 misses', '1,000 misses']);
  });
});
