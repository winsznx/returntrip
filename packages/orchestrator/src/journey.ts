import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserResult, BrowserStage, EdgeComparison } from '@returntrip/contracts';
import { compareRoundTrip, headline, type ParsedArtifact, parseArtifact } from '@returntrip/csv-comparator';
import type { ArtifactRecord } from '@returntrip/storage';
import { fillPlaceholders } from '@returntrip/target-runtime';

import type { RunContext } from './context.ts';
import { RunStop } from './errors.ts';
import { groupedNumber } from './messages.ts';
import type { CapturedFile, ObservedUpload } from './ports.ts';
import type { TargetSession } from './target.ts';

const CAPTURE_SETTLE_MS = 15_000;

export interface JourneyResult {
  readonly verdict: 'equivalent' | 'mismatch' | 'invalid';
  readonly edges: readonly EdgeComparison[];
  readonly browser: Partial<Record<BrowserStage, BrowserResult>>;
  readonly exportArtifact: ArtifactRecord;
  readonly reexportArtifact: ArtifactRecord;
  readonly destination: string;
  readonly headline: string;
}

const STAGE_PHASE = {
  export: 'EXPORTING',
  'create-destination': 'DESTINATION_READY',
  restore: 'RESTORING',
  reexport: 'REEXPORTING',
} as const;

const STAGE_MESSAGE: Readonly<Record<BrowserStage, string>> = {
  export: 'Kane is opening the source workspace and clicking Export.',
  'create-destination': 'Kane is creating an empty workspace to restore into.',
  restore: 'Kane is uploading the exported file into the empty workspace.',
  reexport: 'Kane is exporting the restored workspace.',
};

/**
 * Runs one Kane objective, keeps its raw output and sealed evidence pack, and retries once for
 * infrastructure failures only. A browser that didn't finish never becomes a data verdict.
 */
async function runStage(
  ctx: RunContext,
  stage: BrowserStage,
  objective: string,
  url: string,
): Promise<BrowserResult> {
  const retries = ctx.config.limits.maxInfraRetriesPerStage;
  for (let attempt = 0; ; attempt += 1) {
    ctx.throwIfCanceled();
    ctx.reserveCredits(stage);
    ctx.store.updateRun(ctx.runId, { phase: STAGE_PHASE[stage] });
    ctx.emit('phase.changed', { phase: STAGE_PHASE[stage], message: STAGE_MESSAGE[stage] });
    ctx.emit('browser.started', { stage, objective, url });

    const logDir = join(ctx.workDir, 'kane', `a${ctx.attempt}-${stage}-${attempt}`);
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const { result, stdoutPath, stderrPath } = await ctx.deps.browser.run({
      stage,
      objective,
      url,
      timeoutMs: ctx.config.limits.browserRunTimeoutMs,
      cwd: logDir,
      logDir,
      signal: ctx.signal,
      onProgress: (progress) => ctx.emit('browser.progress', { stage, ...progress }),
    });

    ctx.chargeCredits(result.creditsUsed);
    ctx.store.recordStage(ctx.runId, ctx.attempt, stage, result);
    const prefix = `${stage}${attempt > 0 ? `-retry${attempt}` : ''}`;
    const keep = async (
      path: string | null,
      kind: 'kane-stdout' | 'kane-stderr' | 'evidence-pack',
      file: string,
      mediaType: string,
    ): Promise<void> => {
      if (!path) return;
      await ctx.store
        .importArtifact({
          runId: ctx.runId,
          attempt: ctx.attempt,
          kind,
          fileName: file,
          sourcePath: path,
          mediaType,
          provenance: {
            stage,
            vendor: result.vendor,
            version: result.version,
            session: result.vendorSessionId,
          },
        })
        .catch((error: unknown) => {
          ctx.emit('warning', {
            code: 'EVIDENCE_COPY_FAILED',
            message: `Could not keep ${file}: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    };
    await keep(stdoutPath, 'kane-stdout', `${prefix}.kane.ndjson`, 'application/x-ndjson');
    await keep(stderrPath, 'kane-stderr', `${prefix}.kane.stderr.log`, 'text/plain');
    await keep(result.evidencePackPath, 'evidence-pack', `${prefix}.evidence.zip`, 'application/zip');

    ctx.emit('browser.finished', {
      stage,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      oneLiner: result.oneLiner,
      creditsUsed: result.creditsUsed,
      durationMs: result.durationMs,
    });

    if (result.outcome === 'passed') return result;
    if (result.outcome === 'canceled' || ctx.signal.aborted) ctx.throwIfCanceled();
    const retryable = result.outcome === 'infra_error' || result.outcome === 'unknown';
    if (retryable && attempt < retries) {
      ctx.emit('warning', {
        code: 'BROWSER_RETRY',
        message: `Kane ${stage} hit an infrastructure error; retrying once.`,
      });
      continue;
    }
    const what = result.oneLiner ?? result.reason ?? result.outcome;
    throw new RunStop(
      'EXECUTION_FAILED',
      `BROWSER_${stage.toUpperCase().replace('-', '_')}`,
      `Kane could not finish the ${stage} step: ${what}`,
    );
  }
}

async function settle<T>(promise: Promise<T>, stage: string): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new RunStop(
      'EXECUTION_FAILED',
      'CAPTURE_MISSING',
      `Kane finished the ${stage} step but ReturnTrip did not capture a complete file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function keepCapture(
  ctx: RunContext,
  file: CapturedFile,
  kind: 'export' | 'reexport',
  workspace: string,
): Promise<ArtifactRecord> {
  const artifact = await ctx.store.importArtifact({
    runId: ctx.runId,
    attempt: ctx.attempt,
    kind,
    fileName: `${kind}.csv`,
    sourcePath: file.path,
    mediaType: 'text/csv',
    expectedSha256: file.sha256,
    provenance: {
      capturedBy: 'returntrip-proxy',
      workspace,
      status: file.status,
      contentType: file.contentType,
      contentDisposition: file.contentDisposition,
      capturedAt: file.capturedAt,
    },
  });
  ctx.emit('artifact.captured', {
    kind,
    artifactId: artifact.id,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    rows: null,
  });
  return artifact;
}

function parse(
  ctx: RunContext,
  bytes: Uint8Array,
  artifact: 'source' | 'export' | 'reexport',
): ParsedArtifact {
  return parseArtifact(bytes, ctx.config.contract, { artifact, maxRows: ctx.config.limits.maxRows });
}

function runHeadline(edges: readonly EdgeComparison[], sourceRows: number): string {
  const failing =
    edges.find((edge) => edge.summary.edge === 'source_reexport' && !edge.summary.isEquivalent) ??
    edges.find((edge) => !edge.summary.isEquivalent);
  if (failing) return headline(failing.summary);
  return `${groupedNumber(sourceRows)} of ${groupedNumber(sourceRows)} records came back identical after export, restore and re-export.`;
}

/**
 * One full verification: export the source workspace, restore the captured bytes into a brand new
 * workspace, export again, and compare all three edges against the trusted source.
 */
export async function runJourney(
  ctx: RunContext,
  target: TargetSession,
  sourceBytes: Uint8Array,
): Promise<JourneyResult> {
  const journey = ctx.config.journey;
  const sourceParsed = parse(ctx, sourceBytes, 'source');
  if (!sourceParsed.comparable || sourceParsed.invalidRowCount > 0) {
    throw new RunStop(
      'INVALID_CONFIG',
      'SOURCE_INVALID',
      `The trusted source does not satisfy its own contract: ${sourceParsed.schemaErrors[0]?.message ?? 'invalid rows'}`,
    );
  }
  const destination = `restore-${ctx.attempt}-${randomBytes(3).toString('hex')}`;
  const workspaceUrl = (workspace: string): string =>
    fillPlaceholders(journey.workspaceUrl, { origin: target.origin, workspace });
  const values = {
    origin: target.origin,
    sourceUrl: workspaceUrl(journey.sourceWorkspace),
    destinationUrl: workspaceUrl(destination),
    destinationName: destination,
    expectedRows: sourceParsed.rowCount,
    expectedRowsGrouped: groupedNumber(sourceParsed.rowCount),
  };
  const browser: Partial<Record<BrowserStage, BrowserResult>> = {};

  const exportWait = target.capture.expectExport('export', journey.sourceWorkspace);
  browser.export = await runStage(
    ctx,
    'export',
    fillPlaceholders(journey.export, values),
    values.sourceUrl,
  ).catch((error: unknown) => {
    exportWait.cancel();
    throw error;
  });
  const exportArtifact = await keepCapture(
    ctx,
    await settle(exportWait.wait(CAPTURE_SETTLE_MS), 'export'),
    'export',
    journey.sourceWorkspace,
  );
  ctx.store.updateRun(ctx.runId, { phase: 'EXPORT_CAPTURED' });

  browser['create-destination'] = await runStage(
    ctx,
    'create-destination',
    fillPlaceholders(journey.createDestination, values),
    `${target.origin}/`,
  );
  ctx.store.setAttemptDestination(ctx.runId, ctx.attempt, destination);

  const restoreFile = ctx.store.artifactPath(exportArtifact);
  const restoreWait = ctx.config.capture.restoreRoute
    ? target.capture.expectRestore('restore', destination)
    : null;
  browser.restore = await runStage(
    ctx,
    'restore',
    fillPlaceholders(journey.restore, { ...values, restoreFile }),
    values.destinationUrl,
  ).catch((error: unknown) => {
    restoreWait?.cancel();
    throw error;
  });
  await verifyLineage(
    ctx,
    restoreWait ? await settle(restoreWait.wait(CAPTURE_SETTLE_MS), 'restore') : null,
    exportArtifact,
  );
  ctx.store.updateRun(ctx.runId, { phase: 'RESTORED' });

  const reexportWait = target.capture.expectExport('reexport', destination);
  browser.reexport = await runStage(
    ctx,
    'reexport',
    fillPlaceholders(journey.reexport, values),
    values.destinationUrl,
  ).catch((error: unknown) => {
    reexportWait.cancel();
    throw error;
  });
  const reexportArtifact = await keepCapture(
    ctx,
    await settle(reexportWait.wait(CAPTURE_SETTLE_MS), 'reexport'),
    'reexport',
    destination,
  );
  ctx.store.updateRun(ctx.runId, { phase: 'COMPARING' });
  ctx.emit('phase.changed', {
    phase: 'COMPARING',
    message: 'Comparing every record against the trusted source.',
  });

  const comparison = compareRoundTrip(
    {
      source: sourceParsed,
      exported: parse(ctx, await ctx.store.readArtifact(exportArtifact), 'export'),
      reexported: parse(ctx, await ctx.store.readArtifact(reexportArtifact), 'reexport'),
    },
    ctx.config.contract,
  );
  for (const edge of comparison.edges) {
    ctx.store.recordComparison(ctx.runId, ctx.attempt, edge.summary.edge, edge.summary, edge.differences);
    ctx.emit('comparison.completed', {
      edge: edge.summary.edge,
      isEquivalent: edge.summary.isEquivalent,
      expectedRows: edge.summary.expectedRows,
      observedRows: edge.summary.observedRows,
      matched: edge.summary.matchedIdenticalOccurrences,
      headline: headline(edge.summary),
    });
  }
  await ctx.store.writeArtifact({
    runId: ctx.runId,
    attempt: ctx.attempt,
    kind: 'comparison',
    fileName: 'comparison.json',
    data: `${JSON.stringify(comparison, null, 2)}\n`,
    mediaType: 'application/json',
  });
  return {
    verdict: comparison.verdict,
    edges: comparison.edges,
    browser,
    exportArtifact,
    reexportArtifact,
    destination,
    headline: runHeadline(comparison.edges, sourceParsed.rowCount),
  };
}

/** The file the browser uploaded must be byte-identical to the export ReturnTrip captured. */
async function verifyLineage(
  ctx: RunContext,
  upload: ObservedUpload | null,
  exportArtifact: ArtifactRecord,
): Promise<void> {
  if (!upload) {
    ctx.emit('warning', {
      code: 'LINEAGE_UNOBSERVED',
      message: 'No restore route is configured, so the uploaded bytes were not hashed.',
    });
    return;
  }
  await ctx.store.writeArtifact({
    runId: ctx.runId,
    attempt: ctx.attempt,
    kind: 'restore-upload',
    fileName: 'restore-upload.json',
    data: `${JSON.stringify({ ...upload, exportSha256: exportArtifact.sha256 }, null, 2)}\n`,
    mediaType: 'application/json',
  });
  if (upload.sha256 !== exportArtifact.sha256) {
    throw new RunStop(
      'EXECUTION_FAILED',
      'LINEAGE_MISMATCH',
      `The browser uploaded a different file than the export ReturnTrip captured (${upload.sha256.slice(0, 12)} vs ${exportArtifact.sha256.slice(0, 12)}).`,
    );
  }
}
