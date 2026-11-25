import { describe, expect, it } from 'vitest';

import { parseCsv } from '../src/lib/csv.ts';
import { groupDifferences } from '../src/lib/differences.ts';
import { packTryIndex, recordedSource } from '../src/lib/evidence.ts';
import { recordedTotals } from '../src/lib/recorded.ts';
import { describeEdge, recordCounts } from '../src/lib/run-model.ts';
import type { Difference, EdgeSummary, PublicIndexEntry, PublicRun } from '../src/lib/types.ts';

// Synthetic fixtures for logic tests only. They are not recorded runs.
function summary(overrides: Partial<EdgeSummary>): EdgeSummary {
  return {
    edge: 'source_reexport',
    isEquivalent: false,
    expectedRows: 1000,
    observedRows: 1000,
    matchedIdenticalOccurrences: 0,
    missingKeyCount: 0,
    unexpectedKeyCount: 0,
    missingOccurrences: 0,
    excessOccurrences: 0,
    duplicateKeyCount: 0,
    changedKeyCount: 1000,
    changedFieldCount: 1000,
    schemaErrorCount: 0,
    orderMismatch: false,
    preservationRate: 0,
    changedFields: [{ field: 'amount', rows: 1000 }],
    ...overrides,
  };
}

function change(row: number, field: string, expected: string, observed: string): Difference {
  return {
    id: `${row}-${field}`,
    edge: 'source_reexport',
    kind: 'FIELD_CHANGED',
    field,
    expectedRaw: expected,
    observedRaw: observed,
    expectedRowRefs: [row],
    observedRowRefs: [row],
    message: `${field} changed`,
  };
}

describe('csv parsing for row context', () => {
  it('reads quotes, doubled quotes, embedded line breaks, CRLF and a BOM', () => {
    // #given
    const text = '﻿vendor,amount\r\n"ACME WASTE, INC.",-5.10\r\n"Smith ""Bros""",0.07\n"two\nlines",1\n';
    // #when
    const table = parseCsv(text);
    // #then
    expect(table.header).toEqual(['vendor', 'amount']);
    expect(table.rows).toEqual([
      ['ACME WASTE, INC.', '-5.10'],
      ['Smith "Bros"', '0.07'],
      ['two\nlines', '1'],
    ]);
  });
});

describe('record inspector grouping', () => {
  it('folds field changes on the same row pair into one record', () => {
    // #given
    const differences = [
      change(1, 'amount', '17104.23', '-17104.23'),
      change(1, 'vendor_name', 'A', 'B'),
      change(2, 'amount', '19038', '-19038.00'),
    ];
    // #when
    const groups = groupDifferences(differences);
    // #then
    expect(groups.map((group) => group.differences.length)).toEqual([2, 1]);
  });
});

describe('run summaries', () => {
  it('describes a mismatch and a clean comparison in plain sentences', () => {
    // #given
    const broken = summary({});
    const clean = summary({ isEquivalent: true, matchedIdenticalOccurrences: 1000, changedFields: [] });
    // #when
    const text = [describeEdge(broken), describeEdge(clean)];
    // #then
    expect(text).toEqual([
      '0 of 1,000 records came back identical. The amount field changed in 1,000 records.',
      '1,000 of 1,000 records came back identical.',
    ]);
  });

  it('reads the three counts from the comparisons, never assuming they match', () => {
    // #given
    const attempt = {
      number: 1,
      kind: 'initial' as const,
      outcome: null,
      destination: null,
      patchSha256: null,
      startedAt: '2026-11-25T18:00:00.000Z',
      finishedAt: null,
      stages: [],
      comparisons: [
        summary({ edge: 'source_export', observedRows: 999, isEquivalent: false }),
        summary({
          edge: 'source_reexport',
          observedRows: 998,
          matchedIdenticalOccurrences: 990,
          excessOccurrences: 2,
        }),
      ],
    };
    // #when
    const counts = recordCounts(attempt);
    // #then
    expect(counts).toEqual({
      source: 1000,
      firstExport: 999,
      afterRestore: 998,
      preserved: 990,
      unexpected: 2,
    });
  });
});

describe('recorded bundles', () => {
  it('filters the published sample and keeps the full total when unfiltered', async () => {
    // #given
    const items = [change(1, 'amount', '1', '-1'), change(2, 'vendor_name', 'A', 'B')];
    const run = {
      report: { runId: '00000000-0000-4000-8000-000000000002' },
      differences: { '1': { source_reexport: { total: 1000, items } } },
      files: [],
      screenshots: [],
    } as unknown as PublicRun;
    const source = recordedSource(run);
    // #when
    const all = await source.differences({ attempt: 1, edge: 'source_reexport', offset: 0, limit: 25 });
    const vendor = await source.differences({
      attempt: 1,
      edge: 'source_reexport',
      field: 'vendor_name',
      offset: 0,
      limit: 25,
    });
    // #then
    expect([all.total, all.differences.length, all.sample]).toEqual([1000, 2, { size: 2, edgeTotal: 1000 }]);
    expect([vendor.total, vendor.differences[0]?.field]).toEqual([1, 'vendor_name']);
  });

  it('counts misses: a recreated defect that came back verified', () => {
    // #given
    const entry = (outcome: string, scenario: string | null, mode = 'verify'): PublicIndexEntry => ({
      runId: `${outcome}-${scenario}`,
      recordedAt: '2026-11-25T18:00:00.000Z',
      mode,
      outcome,
      headline: null,
      scenario,
      project: 'demo',
      targetMode: 'managed',
      kaneCreditsUsed: 10,
      durationMs: 1000,
    });
    const runs = [
      entry('VERIFIED', null),
      entry('REPAIRED_VERIFIED', 'sign-flip', 'repair'),
      entry('VERIFIED', 'drop-duplicates'),
      entry('EXECUTION_FAILED', 'comma-split'),
    ];
    // #when
    const totals = recordedTotals(runs);
    // #then
    expect(totals.healthy).toEqual({ attempted: 1, verified: 1 });
    expect(totals.defects).toEqual({ attempted: 3, detected: 1, missed: 1 });
    expect(totals.repairs).toEqual({ attempted: 1, verified: 1 });
    expect(totals.kaneCredits).toBe(40);
  });

  it('counts a real attached app separately from the healthy demo baseline', () => {
    // #given a healthy demo run and a real-app run that caught data changing
    const base = {
      recordedAt: '2026-11-25T18:00:00.000Z',
      mode: 'verify',
      headline: null,
      scenario: null,
      kaneCreditsUsed: 10,
      durationMs: 1000,
    };
    const runs: PublicIndexEntry[] = [
      { ...base, runId: 'demo', outcome: 'VERIFIED', project: 'chicago-payments', targetMode: 'managed' },
      { ...base, runId: 'sure', outcome: 'DATA_MISMATCH', project: 'sure-pre-4754', targetMode: 'attached' },
    ];

    // #when
    const totals = recordedTotals(runs);

    // #then
    expect({ healthy: totals.healthy, realApp: totals.realApp }).toEqual({
      healthy: { attempted: 1, verified: 1 },
      realApp: { attempted: 1, caught: 1, clean: 0 },
    });
  });

  it('matches retried evidence packs to their stage and try', () => {
    // #given
    const names = [
      'export.evidence.zip',
      'export-retry1.evidence.zip',
      'reexport.evidence.zip',
      'create-destination-retry2.evidence.zip',
    ];
    // #when
    const forExport = names.map((name) => packTryIndex(name, 'export'));
    const forCreate = names.map((name) => packTryIndex(name, 'create-destination'));
    // #then
    expect(forExport).toEqual([0, 1, null, null]);
    expect(forCreate).toEqual([null, null, null, 2]);
  });
});
