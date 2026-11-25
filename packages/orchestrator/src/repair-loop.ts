import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserStage, ComparisonEdge, Difference, RepairRequest } from '@returntrip/contracts';
import { canonicalContractHash } from '@returntrip/csv-comparator';
import { buildRepairPrompt, validatePatch } from '@returntrip/repair-agent';
import { restoreTree, sha256, snapshotTree, type TargetCopy } from '@returntrip/target-runtime';

import type { RunContext } from './context.ts';
import { RunStop } from './errors.ts';
import { type JourneyResult, runJourney } from './journey.ts';
import { bootTarget } from './target.ts';

const SAMPLE_PER_SHAPE = 3;
const MIN_AGENT_ATTEMPT_USD = 0.25;
const MAX_SAMPLE = 60;

/** Keeps a few examples of every (edge, kind, field) shape so the agent sees each distinct failure. */
export function sampleDifferences(
  ctx: RunContext,
  attempt: number,
): {
  sample: Difference[];
  totals: Record<ComparisonEdge, number>;
} {
  const totals: Record<ComparisonEdge, number> = { source_export: 0, export_reexport: 0, source_reexport: 0 };
  const sample: Difference[] = [];
  for (const edge of Object.keys(totals) as ComparisonEdge[]) {
    const all = ctx.store.listDifferences(ctx.runId, { attempt, edge, limit: 500 });
    totals[edge] = all.total;
    const perShape = new Map<string, number>();
    for (const difference of all.differences) {
      const shape = `${difference.kind}|${difference.field ?? ''}`;
      const seen = perShape.get(shape) ?? 0;
      if (seen < SAMPLE_PER_SHAPE && sample.length < MAX_SAMPLE) {
        sample.push(difference);
        perShape.set(shape, seen + 1);
      }
    }
  }
  return { sample, totals };
}

function browserSummary(journey: JourneyResult): RepairRequest['browser'] {
  const entries = Object.entries(journey.browser).map(([stage, result]) => [
    stage,
    {
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      oneLiner: result.oneLiner,
      summary: result.summary,
      assertions: result.assertions,
      failedStep: result.failedStep,
    },
  ]);
  return Object.fromEntries(entries) as Partial<Record<BrowserStage, RepairRequest['browser'][BrowserStage]>>;
}

async function guardedHashes(ctx: RunContext): Promise<Record<string, string>> {
  const files = [ctx.loaded.configPath, ctx.loaded.paths.source, ctx.loaded.paths.provenance];
  if (ctx.loaded.paths.scenarioPatch) files.push(ctx.loaded.paths.scenarioPatch);
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = sha256(await readFile(file));
  return hashes;
}

export interface RepairLoopResult {
  readonly fixed: boolean;
  readonly finalJourney: JourneyResult | null;
  readonly acceptedPatchSha256: string | null;
}

/**
 * Bounded repair: give the agent the real evidence, validate what it changed, rebuild, and rerun
 * the identical Kane journey on fresh data. Only a fresh, complete, equivalent comparison counts.
 */
export async function repairLoop(
  ctx: RunContext,
  copy: TargetCopy,
  firstMismatch: JourneyResult,
  sourceBytes: Uint8Array,
): Promise<RepairLoopResult> {
  const app = ctx.config.application;
  if (app.mode !== 'managed') throw new Error('repair needs a managed target');
  const maxAttempts = ctx.config.limits.maxRepairAttempts;
  const failedPatches: string[] = [];
  const history: RepairRequest['previousAttempts'][number][] = [];
  let evidence = firstMismatch;
  let evidenceAttempt = ctx.attempt;
  let lastGoodTree = copy.baseTree;
  const contractHash = canonicalContractHash(ctx.config.contract);
  const guardsBefore = await guardedHashes(ctx);

  for (let repairAttempt = 1; repairAttempt <= maxAttempts; repairAttempt += 1) {
    ctx.throwIfCanceled();
    const remainingUsd = ctx.config.repair.maxAgentBudgetUsd - ctx.agentUsd;
    // Below this an attempt can't do useful work, and Claude Code's own cap could overshoot.
    if (remainingUsd < MIN_AGENT_ATTEMPT_USD) {
      throw new RunStop(
        'BUDGET_EXCEEDED',
        'AGENT_BUDGET',
        `The repair agent used its $${ctx.config.repair.maxAgentBudgetUsd} budget.`,
      );
    }
    ctx.store.updateRun(ctx.runId, { phase: 'REPAIRING' });
    ctx.emit('phase.changed', {
      phase: 'REPAIRING',
      message: `Claude Code is reading the evidence and patching the app (attempt ${repairAttempt} of ${maxAttempts}).`,
    });
    ctx.emit('repair.started', { repairAttempt, maxAttempts });

    const { sample, totals } = sampleDifferences(ctx, evidenceAttempt);
    const request: RepairRequest = {
      schemaVersion: 1,
      runId: ctx.runId,
      repairAttempt,
      baseRevision: copy.baseTree,
      allowedPaths: app.repairPaths,
      hashes: { config: ctx.loaded.configHash, contract: contractHash, source: ctx.config.source.sha256 },
      summaries: evidence.edges.map((edge) => edge.summary),
      differences: sample,
      totalDifferences: totals,
      browser: browserSummary(evidence),
      previousAttempts: history,
    };
    await ctx.store.writeArtifact({
      runId: ctx.runId,
      attempt: evidenceAttempt,
      kind: 'repair-request',
      fileName: `repair-request-${repairAttempt}.json`,
      data: `${JSON.stringify(request, null, 2)}\n`,
      mediaType: 'application/json',
    });

    const logDir = join(ctx.workDir, 'agent', `repair-${repairAttempt}`);
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const { result, rawPath } = await ctx.deps.repair.repair({
      dir: copy.dir,
      prompt: buildRepairPrompt(request),
      timeoutMs: ctx.config.repair.agentTimeoutMs,
      maxBudgetUsd: remainingUsd,
      logDir,
      signal: ctx.signal,
    });
    ctx.chargeAgent(result.costUsd);
    if (rawPath) {
      await ctx.store.importArtifact({
        runId: ctx.runId,
        attempt: evidenceAttempt,
        kind: 'agent-output',
        fileName: `agent-output-${repairAttempt}.json`,
        sourcePath: rawPath,
        mediaType: 'application/json',
      });
    }

    const guardsAfter = await guardedHashes(ctx);
    if (JSON.stringify(guardsAfter) !== JSON.stringify(guardsBefore)) {
      throw new RunStop(
        'REPAIR_UNRESOLVED',
        'PROTECTED_INPUT_CHANGED',
        'A protected input changed during repair; the run was stopped.',
      );
    }

    const validated = await validatePatch(copy.dir, copy.baseTree, {
      allowedPaths: app.repairPaths,
      protectedPaths: app.protectedPaths,
      maxChangedFiles: ctx.config.repair.maxChangedFiles,
      maxChangedLines: ctx.config.repair.maxChangedLines,
      previousPatchHashes: failedPatches,
    });
    const record = {
      runId: ctx.runId,
      attempt: repairAttempt,
      status: result.status,
      cause: result.cause,
      agentVersion: result.agentVersion,
      models: result.models,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      files: validated.validation.files,
      linesChanged: validated.validation.linesChanged,
    };

    if (result.status !== 'patch' || !validated.validation.ok) {
      const reason =
        result.status !== 'patch'
          ? (result.error ?? `the agent returned ${result.status}${result.cause ? `: ${result.cause}` : ''}`)
          : `${validated.validation.rejection?.code}: ${validated.validation.rejection?.detail}`;
      ctx.store.recordRepair({ ...record, reason, patchSha256: validated.validation.sha256 });
      ctx.emit('repair.rejected', { repairAttempt, reason });
      history.push({
        repairAttempt,
        patchSha256: validated.validation.sha256,
        result: `rejected: ${reason}`,
      });
      await restoreTree(copy.dir, lastGoodTree);
      if (result.status === 'no_patch' || result.status === 'denied') break;
      continue;
    }

    const patchSha = validated.validation.sha256 ?? sha256(validated.patch);
    ctx.store.recordRepair({ ...record, reason: null, patchSha256: patchSha });
    await ctx.store.writeArtifact({
      runId: ctx.runId,
      attempt: evidenceAttempt,
      kind: 'patch',
      fileName: `repair-${repairAttempt}.patch`,
      data: validated.patch,
      mediaType: 'text/x-diff',
      provenance: { baseTree: copy.baseTree, cause: result.cause, models: result.models },
    });
    ctx.emit('repair.patch', {
      repairAttempt,
      patchSha256: patchSha,
      filesChanged: [...validated.validation.files],
      linesChanged: validated.validation.linesChanged,
      cause: result.cause ?? 'The agent did not explain the cause.',
    });

    ctx.attempt += 1;
    ctx.store.startAttempt(ctx.runId, ctx.attempt, 'repair', patchSha);
    ctx.store.updateRun(ctx.runId, { phase: 'REBUILDING' });
    ctx.emit('phase.changed', {
      phase: 'REBUILDING',
      message: 'Restarting the patched app on fresh data and running the same Kane journey again.',
    });
    const target = await bootTarget(ctx, copy);
    let journey: JourneyResult;
    try {
      journey = await runJourney(ctx, target, sourceBytes);
    } finally {
      await target.stop();
    }
    ctx.store.finishAttempt(ctx.runId, ctx.attempt, {
      outcome: journey.verdict,
      destination: journey.destination,
      patchSha256: patchSha,
    });
    if (journey.verdict === 'equivalent') {
      return { fixed: true, finalJourney: journey, acceptedPatchSha256: patchSha };
    }
    failedPatches.push(patchSha);
    history.push({ repairAttempt, patchSha256: patchSha, result: `still different: ${journey.headline}` });
    lastGoodTree = await snapshotTree(copy.dir);
    evidence = journey;
    evidenceAttempt = ctx.attempt;
  }
  return { fixed: false, finalJourney: evidence, acceptedPatchSha256: null };
}
