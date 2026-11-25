import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EdgeSummary, RunEvent } from '@returntrip/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunRecord, RunStore } from '../src/index.ts';

const BUDGET = { maxKaneCredits: 500, maxRepairAttempts: 3, maxAgentBudgetUsd: 5 };

function newRun(store: RunStore): RunRecord {
  return store.createRun({
    project: 'payments',
    mode: 'verify',
    configPath: '/tmp/returntrip.yaml',
    configHash: 'a'.repeat(64),
    contractHash: 'b'.repeat(64),
    sourceHash: 'c'.repeat(64),
    baseRevision: null,
    budget: BUDGET,
  });
}

const AMOUNT_SUMMARY: EdgeSummary = {
  edge: 'source_reexport',
  isEquivalent: false,
  expectedRows: 2,
  observedRows: 2,
  matchedIdenticalOccurrences: 1,
  missingKeyCount: 0,
  unexpectedKeyCount: 0,
  missingOccurrences: 0,
  excessOccurrences: 0,
  duplicateKeyCount: 0,
  changedKeyCount: 1,
  changedFieldCount: 1,
  schemaErrorCount: 0,
  orderMismatch: false,
  preservationRate: 0.5,
  changedFields: [{ field: 'amount', rows: 1 }],
};

describe('RunStore', () => {
  let root: string;
  let store: RunStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'returntrip-store-'));
    store = await RunStore.open(root);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  describe('runs', () => {
    it('keeps runs after the database is closed and reopened', async () => {
      // #given
      const run = newRun(store);
      store.close();

      // #when
      store = await RunStore.open(root);

      // #then
      expect(store.getRun(run.id)?.project).toBe('payments');
    });

    it('pages runs newest first and the cursor visits every run exactly once', () => {
      // #given
      const ids = Array.from({ length: 5 }, () => newRun(store).id);

      // #when
      const first = store.listRuns({ limit: 2 });
      const second = store.listRuns({ limit: 2, cursor: first.nextCursor });
      const third = store.listRuns({ limit: 2, cursor: second.nextCursor });

      // #then
      const seen = [...first.runs, ...second.runs, ...third.runs].map((run) => run.id);
      expect({ unique: new Set(seen), count: seen.length, last: third.nextCursor }).toEqual({
        unique: new Set(ids),
        count: 5,
        last: null,
      });
    });

    it('rejects a malformed cursor', () => {
      // #given
      const cursor = Buffer.from('"not-a-pair"').toString('base64url');

      // #when
      const list = (): unknown => store.listRuns({ cursor });

      // #then
      expect(list).toThrow(/invalid cursor/);
    });

    it('closes runs left active by another process as interrupted, never verified', () => {
      // #given
      const run = newRun(store);

      // #when
      store.reconcileInterrupted(() => false);

      // #then
      expect(store.getRun(run.id)).toMatchObject({ outcome: 'EXECUTION_FAILED', failureCode: 'INTERRUPTED' });
    });

    it('refuses to delete an active run', async () => {
      // #given
      const run = newRun(store);

      // #when
      const deletion = store.deleteRun(run.id);

      // #then
      await expect(deletion).rejects.toThrow(/active/);
    });

    it('deletes a finished run together with its artifacts', async () => {
      // #given
      const run = newRun(store);
      store.updateRun(run.id, {
        status: 'finished',
        outcome: 'VERIFIED',
        finishedAt: new Date().toISOString(),
      });
      await store.writeArtifact({
        runId: run.id,
        attempt: 1,
        kind: 'export',
        fileName: 'e.csv',
        data: 'x',
        mediaType: 'text/csv',
      });

      // #when
      await store.deleteRun(run.id);

      // #then
      expect({ run: store.getRun(run.id), artifacts: store.listArtifacts(run.id) }).toEqual({
        run: null,
        artifacts: [],
      });
    });
  });

  describe('events', () => {
    it('assigns gapless sequence numbers and replays after a given seq', () => {
      // #given
      const run = newRun(store);
      store.appendEvent(run.id, {
        type: 'run.created',
        attempt: 0,
        payload: { mode: 'verify', project: 'payments' },
      });
      store.appendEvent(run.id, {
        type: 'phase.changed',
        attempt: 1,
        payload: { phase: 'EXPORTING', message: 'Kane is exporting the source workspace' },
      });

      // #when
      const all = store.listEvents(run.id).map((event) => event.seq);
      const afterFirst = store.listEvents(run.id, 0).map((event) => event.type);

      // #then
      expect({ all, afterFirst }).toEqual({ all: [0, 1], afterFirst: ['phase.changed'] });
    });

    it('rejects an event whose payload breaks the schema and stores nothing', () => {
      // #given
      const run = newRun(store);

      // #when
      const append = (): unknown =>
        store.appendEvent(run.id, {
          type: 'phase.changed',
          attempt: 0,
          payload: { phase: 'NOT_A_PHASE', message: 'x' } as never,
        });

      // #then
      expect(append).toThrow();
      expect(store.listEvents(run.id)).toHaveLength(0);
    });

    it('delivers live events to subscribers until they unsubscribe', () => {
      // #given
      const run = newRun(store);
      const seen: RunEvent[] = [];
      const unsubscribe = store.subscribe(run.id, (event) => seen.push(event));

      // #when
      store.appendEvent(run.id, { type: 'warning', attempt: 0, payload: { code: 'X', message: 'first' } });
      unsubscribe();
      store.appendEvent(run.id, { type: 'warning', attempt: 0, payload: { code: 'X', message: 'second' } });

      // #then
      expect(seen.map((event) => event.seq)).toEqual([0]);
    });
  });

  describe('artifacts', () => {
    it('stores bytes and returns them unchanged', async () => {
      // #given
      const run = newRun(store);

      // #when
      const artifact = await store.writeArtifact({
        runId: run.id,
        attempt: 1,
        kind: 'export',
        fileName: 'export.csv',
        data: 'a,b\r\n1,2\r\n',
        mediaType: 'text/csv',
      });

      // #then
      expect((await store.readArtifact(artifact)).toString()).toBe('a,b\r\n1,2\r\n');
    });

    it('refuses to return bytes that no longer match the recorded hash', async () => {
      // #given
      const run = newRun(store);
      const artifact = await store.writeArtifact({
        runId: run.id,
        attempt: 1,
        kind: 'export',
        fileName: 'export.csv',
        data: 'original',
        mediaType: 'text/csv',
      });
      await writeFile(store.artifactPath(artifact), 'tampered');

      // #when
      const read = store.readArtifact(artifact);

      // #then
      await expect(read).rejects.toThrow(/integrity/);
    });

    it('imports an existing file byte for byte', async () => {
      // #given
      const run = newRun(store);
      const source = join(root, 'capture.csv');
      await writeFile(source, 'x\r\n');

      // #when
      const artifact = await store.importArtifact({
        runId: run.id,
        attempt: 1,
        kind: 'export',
        fileName: 'capture.csv',
        sourcePath: source,
        mediaType: 'text/csv',
      });

      // #then
      expect(await readFile(store.artifactPath(artifact), 'utf8')).toBe('x\r\n');
    });

    it('rejects an import whose bytes differ from the expected hash', async () => {
      // #given
      const run = newRun(store);
      const source = join(root, 'capture.csv');
      await writeFile(source, 'x\r\n');

      // #when
      const imported = store.importArtifact({
        runId: run.id,
        attempt: 1,
        kind: 'export',
        fileName: 'capture.csv',
        sourcePath: source,
        mediaType: 'text/csv',
        expectedSha256: '0'.repeat(64),
      });

      // #then
      await expect(imported).rejects.toThrow(/hash changed/);
    });

    it.each(['../x.csv', '/etc/passwd', 'a/b.csv', '.hidden'])(
      'refuses the unsafe file name %s',
      async (fileName) => {
        // #given
        const run = newRun(store);

        // #when
        const write = store.writeArtifact({
          runId: run.id,
          attempt: 1,
          kind: 'export',
          fileName,
          data: 'x',
          mediaType: 'text/csv',
        });

        // #then
        await expect(write).rejects.toThrow(/unsafe/);
      },
    );
  });

  describe('comparisons', () => {
    it('stores a summary and filters its differences by field', () => {
      // #given
      const run = newRun(store);
      store.recordComparison(run.id, 1, 'source_reexport', AMOUNT_SUMMARY, [
        {
          id: 'd1',
          edge: 'source_reexport',
          kind: 'FIELD_CHANGED',
          field: 'amount',
          expectedRaw: '10.00',
          observedRaw: '-10.00',
          expectedRowRefs: [1],
          observedRowRefs: [1],
          message: 'amount changed',
        },
      ]);

      // #when
      const page = store.listDifferences(run.id, { attempt: 1, edge: 'source_reexport', field: 'amount' });

      // #then
      expect({ total: page.total, observed: page.differences[0]?.observedRaw }).toEqual({
        total: 1,
        observed: '-10.00',
      });
    });
  });
});
