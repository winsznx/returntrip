import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunMode, RunOutcome } from '@returntrip/contracts';
import { canonicalContractHash } from '@returntrip/csv-comparator';
import { buildRunReport, type RunReport, renderMarkdown } from '@returntrip/reporting';
import type { RunRecord, RunStore } from '@returntrip/storage';
import { removeTargetCopy, type TargetCopy } from '@returntrip/target-runtime';

import { type LoadedConfig, readPinnedSource } from './config-loader.ts';
import { type EngineOptions, RunContext } from './context.ts';
import { RunStop } from './errors.ts';
import { type JourneyResult, runJourney } from './journey.ts';
import { acquireProjectLock } from './lock.ts';
import { OUTCOME_TEXT } from './messages.ts';
import type { EngineDeps } from './ports.ts';
import { repairLoop } from './repair-loop.ts';
import { bootTarget, prepareCopy } from './target.ts';

export interface StartRunInput {
  readonly store: RunStore;
  readonly loaded: LoadedConfig;
  readonly mode: RunMode;
  readonly deps: EngineDeps;
  readonly options: EngineOptions;
  readonly signal: AbortSignal;
  readonly fromRunId?: string;
  /** Called once the run row exists, before any work, so callers can show or cancel it. */
  readonly onCreated?: (run: RunRecord) => void;
}

interface Verdict {
  readonly outcome: RunOutcome;
  readonly headline: string;
  readonly failureCode: string | null;
}

async function preflight(ctx: RunContext, mode: RunMode): Promise<Buffer> {
  ctx.store.updateRun(ctx.runId, { phase: 'PREFLIGHT' });
  ctx.emit('phase.changed', {
    phase: 'PREFLIGHT',
    message: 'Checking the config, the trusted source, Kane and the budget.',
  });
  const source = await readPinnedSource(ctx.loaded).catch((error: unknown) => {
    throw new RunStop(
      'INVALID_CONFIG',
      'SOURCE_HASH',
      error instanceof Error ? error.message : String(error),
    );
  });
  if (mode === 'repair') {
    if (ctx.config.application.mode !== 'managed') {
      throw new RunStop(
        'INVALID_CONFIG',
        'REPAIR_NEEDS_MANAGED',
        'Repair needs a managed target; this one is attached.',
      );
    }
    if (!ctx.config.repair.enabled) {
      throw new RunStop(
        'INVALID_CONFIG',
        'REPAIR_DISABLED',
        'Repair is not enabled in this config (repair.enabled: false).',
      );
    }
    if (!(await ctx.deps.repair.version())) {
      throw new RunStop('EXECUTION_FAILED', 'AGENT_MISSING', 'Claude Code is not installed or not on PATH.');
    }
  }
  const version = await ctx.deps.browser.version();
  if (!version)
    throw new RunStop('EXECUTION_FAILED', 'KANE_MISSING', 'kane-cli is not installed or not on PATH.');
  ctx.store.updateRun(ctx.runId, { kaneVersion: version });
  const balance = await ctx.deps.browser.balance();
  if (balance !== null && balance < 4 * 30) {
    throw new RunStop(
      'BUDGET_EXCEEDED',
      'KANE_BALANCE',
      `Your Kane account has ${balance} credits; one round trip needs about 120.`,
    );
  }
  return source;
}

/** Ends a headline with a period so headlines can be joined into one paragraph. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function verdictFor(
  mode: RunMode,
  initial: JourneyResult,
  repaired: { fixed: boolean; final: JourneyResult | null } | null,
): Verdict {
  if (initial.verdict === 'equivalent')
    return { outcome: 'VERIFIED', headline: initial.headline, failureCode: null };
  if (initial.verdict === 'invalid') {
    return { outcome: 'INCONCLUSIVE', headline: initial.headline, failureCode: 'SOURCE_INVALID' };
  }
  if (mode === 'verify' || !repaired)
    return { outcome: 'DATA_MISMATCH', headline: initial.headline, failureCode: null };
  if (repaired.fixed && repaired.final) {
    return {
      outcome: 'REPAIRED_VERIFIED',
      headline: `Fixed. First run: ${sentence(initial.headline)} After the patch: ${sentence(repaired.final.headline)}`,
      failureCode: null,
    };
  }
  return {
    outcome: 'REPAIR_UNRESOLVED',
    headline: `${sentence(initial.headline)} The agent's patches did not fix it.`,
    failureCode: 'NOT_FIXED',
  };
}

export function scenarioOf(loaded: LoadedConfig): RunReport['scenario'] {
  const app = loaded.config.application;
  if (app.mode !== 'managed' || !app.scenario) return null;
  return {
    name: app.scenario.name,
    disclosure: app.scenario.disclosure,
    reference: app.scenario.reference ?? null,
  };
}

async function writeReports(ctx: RunContext): Promise<void> {
  const report = buildRunReport(ctx.store, ctx.runId, scenarioOf(ctx.loaded));
  await ctx.store.writeArtifact({
    runId: ctx.runId,
    attempt: 0,
    kind: 'report-json',
    fileName: 'report.json',
    data: `${JSON.stringify(report, null, 2)}\n`,
    mediaType: 'application/json',
  });
  await ctx.store.writeArtifact({
    runId: ctx.runId,
    attempt: 0,
    kind: 'report-markdown',
    fileName: 'report.md',
    data: renderMarkdown(report),
    mediaType: 'text/markdown',
  });
}

/** Cleanup failures don't change the verdict, but they're recorded so leftovers are visible. */
async function cleanup(ctx: RunContext, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    ctx.emit('warning', {
      code: 'CLEANUP_FAILED',
      message: `Could not remove the ${what}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Runs one verification (and, in repair mode, the bounded repair loop) to a terminal outcome.
 * Every path ends in a recorded outcome; nothing defaults to VERIFIED.
 */
export async function executeRun(input: StartRunInput): Promise<RunRecord> {
  const { store, loaded, mode } = input;
  const release = await acquireProjectLock(store.root, loaded.config.project);
  const sourceHash = loaded.config.source.sha256;
  const run = store.createRun({
    project: loaded.config.project,
    mode,
    configPath: loaded.configPath,
    configHash: loaded.configHash,
    contractHash: canonicalContractHash(loaded.config.contract),
    sourceHash,
    baseRevision: null,
    fromRunId: input.fromRunId ?? null,
    budget: {
      maxKaneCredits: loaded.config.limits.maxKaneCredits,
      maxRepairAttempts: loaded.config.limits.maxRepairAttempts,
      maxAgentBudgetUsd: loaded.config.repair.maxAgentBudgetUsd,
    },
  });
  input.onCreated?.(run);
  const workDir = join(input.options.workRoot ?? join(store.root, 'work'), run.id);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const overall = AbortSignal.any([input.signal, AbortSignal.timeout(loaded.config.limits.overallTimeoutMs)]);
  const ctx = new RunContext({
    store,
    loaded,
    deps: input.deps,
    options: input.options,
    signal: overall,
    run,
    workDir,
  });
  ctx.emit('run.created', { mode, project: loaded.config.project });

  let copy: TargetCopy | null = null;
  let verdict: Verdict;
  try {
    const source = await preflight(ctx, mode);
    await store.writeArtifact({
      runId: run.id,
      attempt: 0,
      kind: 'source',
      fileName: 'source.csv',
      data: source,
      mediaType: 'text/csv',
      provenance: JSON.parse(await readFile(loaded.paths.provenance, 'utf8')) as Record<string, unknown>,
    });

    ctx.attempt = 1;
    store.updateRun(run.id, { phase: 'PREPARING' });
    ctx.emit('phase.changed', {
      phase: 'PREPARING',
      message:
        loaded.config.application.mode === 'managed'
          ? 'Starting a fresh copy of the app with the trusted source loaded.'
          : 'Loading the trusted source into the running app through its seed command.',
    });
    if (loaded.config.application.mode === 'managed') {
      copy = await prepareCopy(ctx);
      store.updateRun(run.id, { baseRevision: copy.baseTree });
    }
    store.startAttempt(run.id, 1, 'initial', copy?.baseTree ?? null);
    const target = await bootTarget(ctx, copy);
    store.updateRun(run.id, { phase: 'SOURCE_READY' });
    let initial: JourneyResult;
    try {
      initial = await runJourney(ctx, target, source);
    } finally {
      await target.stop();
    }
    store.finishAttempt(run.id, 1, { outcome: initial.verdict, destination: initial.destination });

    let repaired: { fixed: boolean; final: JourneyResult | null } | null = null;
    if (mode === 'repair' && initial.verdict === 'mismatch' && copy) {
      const result = await repairLoop(ctx, copy, initial, source);
      repaired = { fixed: result.fixed, final: result.finalJourney };
    }
    verdict = verdictFor(mode, initial, repaired);
  } catch (error) {
    if (overall.aborted && !input.signal.aborted) {
      verdict = {
        outcome: 'EXECUTION_FAILED',
        headline: 'The run hit its overall time limit.',
        failureCode: 'OVERALL_TIMEOUT',
      };
    } else if (input.signal.aborted) {
      verdict = { outcome: 'CANCELED', headline: OUTCOME_TEXT.CANCELED, failureCode: 'CANCELED' };
    } else if (error instanceof RunStop) {
      verdict = { outcome: error.outcome, headline: error.message, failureCode: error.code };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      verdict = {
        outcome: 'EXECUTION_FAILED',
        headline: `ReturnTrip hit an internal error: ${message}`,
        failureCode: 'INTERNAL',
      };
    }
  } finally {
    const leftover = copy;
    if (leftover) await cleanup(ctx, 'target copy', () => removeTargetCopy(leftover.dir));
  }

  store.updateRun(run.id, { phase: 'REPORTING' });
  ctx.emit('run.finished', {
    outcome: verdict.outcome,
    headline: verdict.headline,
    failureCode: verdict.failureCode,
  });
  const finished = store.updateRun(run.id, {
    status: 'finished',
    phase: 'FINISHED',
    outcome: verdict.outcome,
    headline: verdict.headline,
    failureCode: verdict.failureCode,
    finishedAt: new Date().toISOString(),
  });
  await cleanup(ctx, 'report', () => writeReports(ctx));
  await cleanup(ctx, 'work directory', () => rm(workDir, { recursive: true, force: true }));
  await release();
  return store.getRun(run.id) ?? finished;
}
