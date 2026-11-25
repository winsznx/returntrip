import { describe, expect, it } from 'vitest';

import {
  mergeEvent,
  mergeEvents,
  resumeSeq,
  summarizeEvents,
  timelineFromReport,
} from '../src/lib/events.ts';
import type { RunEvent, RunReport } from '../src/lib/types.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function phase(seq: number, message = `phase ${seq}`): RunEvent {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    seq,
    attempt: 1,
    utc: new Date(Date.UTC(2026, 10, 25, 18, 0, seq)).toISOString(),
    elapsedMs: seq * 1000,
    type: 'phase.changed',
    payload: { phase: 'EXPORTING', message },
  };
}

describe('mergeEvent', () => {
  it('appends a newer event', () => {
    // #given
    const events = [phase(0), phase(1)];
    // #when
    const merged = mergeEvent(events, phase(2));
    // #then
    expect(merged.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('ignores an event replayed after a reconnect and keeps the same array', () => {
    // #given
    const events = [phase(0), phase(1), phase(2)];
    // #when
    const merged = mergeEvent(events, phase(1, 'replayed copy'));
    // #then
    expect(merged).toBe(events);
    expect(merged[1]?.type === 'phase.changed' && merged[1].payload.message).toBe('phase 1');
  });

  it('slots a late gap-filling event into seq order', () => {
    // #given
    const events = [phase(0), phase(1), phase(4)];
    // #when
    const merged = mergeEvents(events, [phase(3), phase(2), phase(4)]);
    // #then
    expect(merged.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('resumes from the last seq held, or -1 when nothing arrived yet', () => {
    // #given
    const events = mergeEvents([], [phase(5), phase(6)]);
    // #when
    const resume = [resumeSeq(events), resumeSeq([])];
    // #then
    expect(resume).toEqual([6, -1]);
  });
});

describe('summarizeEvents', () => {
  it('reports the latest phase, budget and the final outcome', () => {
    // #given
    const finished: RunEvent = {
      ...phase(3),
      type: 'run.finished',
      payload: { outcome: 'DATA_MISMATCH', headline: 'amount changed in 1,000 rows', failureCode: null },
    };
    const budget: RunEvent = {
      ...phase(2),
      type: 'budget.updated',
      payload: { kaneCreditsUsed: 41.5, kaneCreditsCap: 600, agentUsd: 0 },
    };
    // #when
    const summary = summarizeEvents([phase(0), phase(1, 'Kane is exporting'), budget, finished]);
    // #then
    expect(summary.phase).toBe('FINISHED');
    expect(summary.phaseMessage).toBe('Kane is exporting');
    expect(summary.kaneCreditsUsed).toBe(41.5);
    expect(summary.finished?.outcome).toBe('DATA_MISMATCH');
  });
});

describe('timelineFromReport', () => {
  it('attaches credits and duration to each Kane line in run order, retries included', () => {
    // #given: synthetic report, not a recorded run. The export stage ran twice in attempt 1.
    const stage = (credits: number, durationMs: number) => ({
      stage: 'export' as const,
      outcome: 'passed' as const,
      reasonCode: null,
      oneLiner: null,
      creditsUsed: credits,
      durationMs,
      vendorDurationSec: null,
      kaneVersion: '0.10.9',
      steps: [],
      assertions: [],
    });
    const report = {
      attempts: [
        {
          number: 1,
          kind: 'initial',
          stages: [stage(3, 1000), stage(5, 2000)],
          comparisons: [],
        },
      ],
      timeline: [
        {
          utc: '2026-11-25T18:00:00.000Z',
          elapsedMs: 10,
          text: 'Kane export: failed, did not find the link',
        },
        { utc: '2026-11-25T18:00:01.000Z', elapsedMs: 20, text: 'Kane export: passed' },
        {
          utc: '2026-11-25T18:00:02.000Z',
          elapsedMs: 30,
          text: 'Captured export (72291 bytes, sha256 743b5c404270)',
        },
        { utc: '2026-11-25T18:00:03.000Z', elapsedMs: 40, text: 'VERIFIED: all good' },
      ],
    } as unknown as RunReport;
    // #when
    const items = timelineFromReport(report);
    // #then
    expect(items.map((item) => [item.kind, item.tone, item.creditsUsed ?? null])).toEqual([
      ['stage', 'bad', 3],
      ['stage', 'ok', 5],
      ['capture', 'neutral', null],
      ['finish', 'ok', null],
    ]);
    expect(items[2]?.sha256).toBe('743b5c404270');
    expect(items[2]?.text).toBe('Captured export (72,291 bytes)');
  });
});
