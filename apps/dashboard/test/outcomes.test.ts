import { RUN_OUTCOMES } from '@returntrip/contracts';
import { describe, expect, it } from 'vitest';

import { OUTCOME_META, outcomeMeta, stageTone } from '../src/lib/outcomes.ts';

describe('outcome labels', () => {
  it('gives every outcome a label, an icon and a plain meaning', () => {
    // #given
    const outcomes = RUN_OUTCOMES;
    // #when
    const metas = outcomes.map((outcome) => OUTCOME_META[outcome]);
    // #then
    for (const meta of metas) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(meta.meaning).toMatch(/\.$/);
    }
    expect(new Set(metas.map((meta) => meta.label)).size).toBe(outcomes.length);
  });

  it('keeps green for data that came back and red for data that did not', () => {
    // #given
    const tones = Object.fromEntries(RUN_OUTCOMES.map((outcome) => [outcome, OUTCOME_META[outcome].tone]));
    // #when
    const ok = RUN_OUTCOMES.filter((outcome) => tones[outcome] === 'ok');
    const bad = RUN_OUTCOMES.filter((outcome) => tones[outcome] === 'bad');
    // #then
    expect(ok).toEqual(['VERIFIED', 'REPAIRED_VERIFIED']);
    expect(bad).toEqual(['DATA_MISMATCH', 'REPAIR_UNRESOLVED']);
  });

  it('shows Running for an active run with no outcome and flags an unknown value', () => {
    // #given
    const active = outcomeMeta(null, true);
    // #when
    const unknown = outcomeMeta('SOMETHING_NEW');
    const proto = outcomeMeta('toString');
    // #then
    expect(active.label).toBe('Running');
    expect(unknown.label).toBe('No outcome');
    expect(proto.label).toBe('No outcome');
  });

  it('maps Kane stage outcomes to tones', () => {
    // #given
    const outcomes = ['passed', 'failed', 'infra_error', 'unknown', 'canceled'] as const;
    // #when
    const tones = outcomes.map(stageTone);
    // #then
    expect(tones).toEqual(['ok', 'bad', 'warn', 'warn', 'neutral']);
  });
});
