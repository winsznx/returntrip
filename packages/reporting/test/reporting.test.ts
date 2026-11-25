import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserResult, EdgeSummary } from '@returntrip/contracts';
import { RunStore } from '@returntrip/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRunReport,
  describeEvent,
  exportPublicBundle,
  renderMarkdown,
  scrubLocalPaths,
} from '../src/index.ts';

const SUMMARY: EdgeSummary = {
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
};

function browser(stage: string): BrowserResult {
  return {
    vendor: 'kane-cli',
    version: '0.10.9',
    outcome: 'passed',
    exitCode: 0,
    signal: null,
    startedAt: '2026-11-25T19:00:00.000Z',
    finishedAt: '2026-11-25T19:01:00.000Z',
    durationMs: 60_000,
    vendorDurationSec: 30,
    vendorSessionId: 's',
    reasonCode: 'success.complete',
    resultCode: '100',
    reason: 'Objective completed',
    summary: null,
    oneLiner: `${stage} done`,
    creditsUsed: 20,
    steps: [
      {
        index: 2,
        status: 'done',
        remark: 'Upload the file /Users/someone/run/export.csv',
        at: '2026-11-25T19:00:30.000Z',
      },
    ],
    failedStep: null,
    assertions: [],
    finalState: {},
    testUrl: 'https://test-manager.lambdatest.com/share/secret',
    evidencePackPath: null,
    protocolWarnings: [],
  };
}

describe('reporting', () => {
  let root: string;
  let store: RunStore;
  let runId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'returntrip-report-'));
    store = await RunStore.open(root);
    const run = store.createRun({
      project: 'payments',
      mode: 'verify',
      configPath: '/tmp/returntrip.yaml',
      configHash: 'a'.repeat(64),
      contractHash: 'b'.repeat(64),
      sourceHash: 'c'.repeat(64),
      baseRevision: null,
      budget: { maxKaneCredits: 600, maxRepairAttempts: 3, maxAgentBudgetUsd: 5 },
    });
    runId = run.id;
    store.startAttempt(runId, 1, 'initial', null);
    store.recordStage(runId, 1, 'restore', browser('restore'));
    store.recordComparison(runId, 1, 'source_reexport', SUMMARY, []);
    store.appendEvent(runId, {
      type: 'run.finished',
      attempt: 1,
      payload: { outcome: 'DATA_MISMATCH', headline: 'amount changed in 1,000 rows', failureCode: null },
    });
    store.updateRun(runId, {
      status: 'finished',
      outcome: 'DATA_MISMATCH',
      headline: 'amount changed in 1,000 rows',
      kaneCreditsUsed: 20,
      finishedAt: '2026-11-25T19:05:00.000Z',
    });
    await store.writeArtifact({
      runId,
      attempt: 1,
      kind: 'export',
      fileName: 'export.csv',
      data: 'a\r\n1\r\n',
      mediaType: 'text/csv',
    });
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('builds a report from stored facts with an artifact manifest', () => {
    // #given a finished mismatch run

    // #when
    const report = buildRunReport(store, runId);

    // #then
    expect({
      outcome: report.outcome,
      stages: report.attempts[0]?.stages.map((s) => s.stage),
      manifest: report.manifest.map((m) => m.kind),
    }).toEqual({ outcome: 'DATA_MISMATCH', stages: ['restore'], manifest: ['export'] });
  });

  it('never carries Kane share links into the report', () => {
    // #given a stage whose Kane result has a Test Manager share URL

    // #when
    const json = JSON.stringify(buildRunReport(store, runId));

    // #then
    expect(json).not.toContain('test-manager.lambdatest.com');
  });

  it('renders the comparison with numerator and denominator in Markdown', () => {
    // #given
    const report = buildRunReport(store, runId);

    // #when
    const markdown = renderMarkdown(report);

    // #then
    expect(markdown).toContain(
      '| Trusted source → export after restore | no | 0 / 1000 | 0 | 0 | 1000 | amount (1000) |',
    );
  });

  it('describes a finished run event in plain words', () => {
    // #given
    const [event] = store.listEvents(runId);

    // #when
    const text = event ? describeEvent(event) : null;

    // #then
    expect(text).toBe('DATA_MISMATCH: amount changed in 1,000 rows');
  });

  it('replaces the home directory in published text', () => {
    // #given
    const text = '{"remark":"Upload the file /Users/someone/run/export.csv"}';

    // #when
    const scrubbed = scrubLocalPaths(text, '/Users/someone');

    // #then
    expect(scrubbed).toBe('{"remark":"Upload the file ~/run/export.csv"}');
  });

  it('publishes only allowlisted files and an index', async () => {
    // #given
    const out = join(root, 'public');

    // #when
    const { dir, run } = await exportPublicBundle({ store, runId, outDir: out, commit: 'abc123' });
    const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8')) as {
      runs: { runId: string }[];
    };

    // #then
    expect({
      files: run.files.map((f) => f.file),
      indexed: index.runs.map((r) => r.runId),
      written: (await readFile(join(dir, 'files', 'a1-export.csv'), 'utf8')).length,
    }).toEqual({ files: ['files/a1-export.csv'], indexed: [runId], written: 6 });
  });
});
