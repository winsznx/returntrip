import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStore } from '@returntrip/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type EngineDeps, executeRun, loadConfig, proxyCaptureDriver } from '../src/index.ts';
import { httpBrowser, scriptedRepair } from './support/http-browser.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', 'examples', 'payment-roundtrip');
const HEALTHY = join(EXAMPLES, 'returntrip.yaml');
const SIGN_FLIP = join(EXAMPLES, 'scenarios', 'sign-flip.yaml');
const IMPORTER = 'src/import/import-payments.ts';
const FLIPPED =
  '      // Ledger convention: incomes are positive, payments out are negative.\n      amountCents: -amountCents,';

const correctFix = scriptedRepair({
  file: IMPORTER,
  from: FLIPPED,
  to: '      amountCents,',
  cause: 'The importer negated every amount.',
});

function deps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  return { browser: httpBrowser(), capture: proxyCaptureDriver(), repair: correctFix, ...overrides };
}

describe('executeRun with the Ledgerline demo app', { timeout: 120_000 }, () => {
  let root: string;
  let store: RunStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'returntrip-engine-'));
    store = await RunStore.open(root);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function run(configPath: string, mode: 'verify' | 'repair', engineDeps: EngineDeps = deps()) {
    const loaded = await loadConfig(configPath);
    return executeRun({
      store,
      loaded,
      mode,
      deps: engineDeps,
      options: { headless: true },
      signal: new AbortController().signal,
    });
  }

  it('verifies a healthy round trip of the 1,000 Chicago payments', async () => {
    // #given the healthy demo app config

    // #when
    const finished = await run(HEALTHY, 'verify');

    // #then
    expect({ outcome: finished.outcome, headline: finished.headline }).toEqual({
      outcome: 'VERIFIED',
      headline: '1,000 of 1,000 records came back identical after export, restore and re-export.',
    });
  });

  it('proves the uploaded file is byte-identical to the captured export', async () => {
    // #given
    const finished = await run(HEALTHY, 'verify');

    // #when
    const artifacts = store.listArtifacts(finished.id);
    const exported = artifacts.find((a) => a.kind === 'export');
    const upload = artifacts.find((a) => a.kind === 'restore-upload');
    const observed = upload
      ? (JSON.parse((await store.readArtifact(upload)).toString()) as { sha256: string })
      : null;

    // #then
    expect(observed?.sha256).toBe(exported?.sha256);
  });

  it('reports a silent sign flip as a data mismatch even though every browser step passed', async () => {
    // #given the sign-flip scenario

    // #when
    const finished = await run(SIGN_FLIP, 'verify');
    const browserOutcomes = store.listStages(finished.id).map((stage) => stage.result.outcome);

    // #then
    expect({
      outcome: finished.outcome,
      browser: [...new Set(browserOutcomes)],
      headline: finished.headline,
    }).toEqual({
      outcome: 'DATA_MISMATCH',
      browser: ['passed'],
      headline: '1,000 of 1,000 rows came back, but amount changed in 1,000 rows',
    });
  });

  it('records the exact before and after value of a flipped amount', async () => {
    // #given
    const finished = await run(SIGN_FLIP, 'verify');

    // #when
    const page = store.listDifferences(finished.id, { attempt: 1, edge: 'source_reexport', limit: 1 });

    // #then
    expect(page.differences[0]).toMatchObject({
      field: 'amount',
      expectedRaw: '17104.23',
      observedRaw: '-17104.23',
    });
  });

  it('keeps the first export clean when the bug is only in the importer', async () => {
    // #given
    const finished = await run(SIGN_FLIP, 'verify');

    // #when
    const sourceToExport = store.listComparisons(finished.id).find((c) => c.edge === 'source_export');

    // #then
    expect(sourceToExport?.summary.isEquivalent).toBe(true);
  });

  it('repairs the importer and proves it with a fresh, complete round trip', async () => {
    // #given the sign-flip scenario and an agent that removes the negation

    // #when
    const finished = await run(SIGN_FLIP, 'repair');
    const attempts = store.listAttempts(finished.id).map((a) => [a.number, a.kind, a.outcome]);

    // #then
    expect({ outcome: finished.outcome, attempts }).toEqual({
      outcome: 'REPAIRED_VERIFIED',
      attempts: [
        [1, 'initial', 'mismatch'],
        [2, 'repair', 'equivalent'],
      ],
    });
  });

  it('stores the accepted patch as a reviewable diff against the scenario base', async () => {
    // #given
    const finished = await run(SIGN_FLIP, 'repair');

    // #when
    const patch = store.listArtifacts(finished.id).find((a) => a.kind === 'patch');
    const text = patch ? (await store.readArtifact(patch)).toString() : '';

    // #then
    expect(text).toContain('-      amountCents: -amountCents,');
  });

  it('rejects an agent that edits the seed script and never reports a repair', async () => {
    // #given an agent that tampers with a protected file
    const tamper = scriptedRepair({
      file: 'src/seed.ts',
      from: 'import',
      to: '// touched\nimport',
      cause: 'edited the seed',
    });

    // #when
    const finished = await run(SIGN_FLIP, 'repair', deps({ repair: tamper }));
    const reasons = store.listRepairs(finished.id).map((r) => r.reason?.split(':')[0]);

    // #then
    expect({ outcome: finished.outcome, reasons }).toEqual({
      outcome: 'REPAIR_UNRESOLVED',
      reasons: ['PROTECTED_PATH', 'PROTECTED_PATH', 'PROTECTED_PATH'],
    });
  });

  it('turns a failed browser step into an execution failure, not a data verdict', async () => {
    // #given a browser that fails the restore step
    const engineDeps = deps({ browser: httpBrowser({ failStage: 'restore' }) });

    // #when
    const finished = await run(HEALTHY, 'verify', engineDeps);

    // #then
    expect({ outcome: finished.outcome, code: finished.failureCode }).toEqual({
      outcome: 'EXECUTION_FAILED',
      code: 'BROWSER_RESTORE',
    });
  });

  it('stops before a stage the credit budget cannot cover', async () => {
    // #given each stage costs more than the 600-credit cap allows for four stages
    const engineDeps = deps({ browser: httpBrowser({ creditsPerStage: 250 }) });

    // #when
    const finished = await run(HEALTHY, 'verify', engineDeps);

    // #then
    expect({ outcome: finished.outcome, code: finished.failureCode }).toEqual({
      outcome: 'BUDGET_EXCEEDED',
      code: 'KANE_CREDITS',
    });
  });

  it('records a canceled run as canceled with no verdict', async () => {
    // #given
    const controller = new AbortController();
    controller.abort();

    // #when
    const finished = await executeRun({
      store,
      loaded: await loadConfig(HEALTHY),
      mode: 'verify',
      deps: deps(),
      options: { headless: true },
      signal: controller.signal,
    });

    // #then
    expect(finished.outcome).toBe('CANCELED');
  });

  it('writes report.json and report.md for every finished run', async () => {
    // #given
    const finished = await run(HEALTHY, 'verify');

    // #when
    const kinds = store.listArtifacts(finished.id).map((a) => a.kind);

    // #then
    expect(kinds).toEqual(
      expect.arrayContaining(['report-json', 'report-markdown', 'source', 'export', 'reexport']),
    );
  });
});
