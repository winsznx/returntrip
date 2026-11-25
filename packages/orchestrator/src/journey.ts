import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserResult, BrowserStage, EdgeComparison } from '@returntrip/contracts';
import { compareRoundTrip, headline, type ParsedArtifact, parseArtifact } from '@returntrip/csv-comparator';
import { DEFAULT_ZIP_LIMITS, parseZip } from '@returntrip/kane-adapter';
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
 * Runs one Kane objective once, keeps its raw output and sealed evidence pack, and returns
 * whatever Kane concluded. Retry policy lives with the caller, which knows whether a stage can be
 * repeated safely.
 */
async function runOnce(
  ctx: RunContext,
  stage: BrowserStage,
  objective: string,
  url: string,
  tryIndex: number,
): Promise<BrowserResult> {
  ctx.throwIfCanceled();
  ctx.reserveCredits(stage);
  ctx.store.updateRun(ctx.runId, { phase: STAGE_PHASE[stage] });
  ctx.emit('phase.changed', { phase: STAGE_PHASE[stage], message: STAGE_MESSAGE[stage] });
  ctx.emit('browser.started', { stage, objective, url });

  const logDir = join(ctx.workDir, 'kane', `a${ctx.attempt}-${stage}-${tryIndex}`);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const {
    result: reported,
    stdoutPath,
    stderrPath,
  } = await ctx.deps.browser.run({
    stage,
    objective,
    url,
    timeoutMs: ctx.config.limits.browserRunTimeoutMs,
    cwd: logDir,
    logDir,
    signal: ctx.signal,
    onProgress: (progress) => ctx.emit('browser.progress', { stage, ...progress }),
    ...(ctx.loaded.paths.variablesFile ? { variablesFile: ctx.loaded.paths.variablesFile } : {}),
  });

  const result = await judgeStage(ctx, stage, reported);
  ctx.chargeCredits(result.creditsUsed);
  ctx.store.recordStage(ctx.runId, ctx.attempt, stage, result);
  const prefix = `${stage}${tryIndex > 0 ? `-retry${tryIndex}` : ''}`;
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
  if (result.outcome === 'canceled' || ctx.signal.aborted) ctx.throwIfCanceled();
  return result;
}

interface StepFailure {
  readonly ok: false;
  readonly stage: BrowserStage;
  readonly reason: string;
  /** False when repeating the unit could double-apply something, e.g. an upload already sent. */
  readonly retryable?: boolean;
}

/**
 * A stage Kane reports as passed must also pass ReturnTrip's stage policy on Kane's own sealed
 * evidence: the run finalized, no step failed, and it asserted something (a run that only
 * clicked proves nothing). A failing verdict turns the stage into a failure, which is retried.
 * An errored verdict means the policy couldn't be judged; Kane's own result stands and a warning
 * is recorded.
 */
async function judgeStage(
  ctx: RunContext,
  stage: BrowserStage,
  result: BrowserResult,
): Promise<BrowserResult> {
  if (result.outcome !== 'passed' || !result.evidencePackPath || !ctx.deps.browser.judge) return result;
  const verdict = await ctx.deps.browser.judge(result.evidencePackPath);
  if (verdict.result === 'pass') return { ...result, evidenceVerdict: verdict };
  if (verdict.result === 'errored') {
    ctx.emit('warning', {
      code: 'STAGE_POLICY_ERRORED',
      message: `Kane could not judge the ${stage} evidence against the stage policy; using its run result.`,
    });
    return { ...result, evidenceVerdict: verdict };
  }
  return {
    ...result,
    evidenceVerdict: verdict,
    outcome: 'failed',
    oneLiner: `Kane reported success, but its evidence failed the stage policy (${verdict.failedGates.join(', ')})`,
  };
}

type StepOutcome<T> = { readonly ok: true; readonly value: T } | StepFailure;

function browserFailure(stage: BrowserStage, result: BrowserResult): StepFailure {
  return { ok: false, stage, reason: result.oneLiner ?? result.reason ?? result.outcome };
}

/**
 * Repeats a unit of browser work on fresh state when Kane fails it, up to the configured limit.
 * Kane's checks can flake (its own triage calls some failures "test-state detection"), so one
 * clean retry is allowed, but a browser that never finished still never becomes a data verdict.
 */
async function withRetries<T>(
  ctx: RunContext,
  label: string,
  unit: (tryIndex: number) => Promise<StepOutcome<T>>,
  retries = ctx.config.limits.maxBrowserRetries,
): Promise<T> {
  for (let tryIndex = 0; ; tryIndex += 1) {
    const outcome = await unit(tryIndex);
    if (outcome.ok) return outcome.value;
    if (tryIndex >= retries || outcome.retryable === false) {
      throw new RunStop(
        'EXECUTION_FAILED',
        `BROWSER_${outcome.stage.toUpperCase().replace('-', '_')}`,
        `Kane could not finish the ${outcome.stage} step: ${outcome.reason}`,
      );
    }
    ctx.emit('warning', {
      code: 'BROWSER_RETRY',
      message: `Kane did not finish the ${outcome.stage} step (${outcome.reason}). Retrying the ${label} once on fresh state.`,
    });
  }
}

/** Runs an export-like stage and waits for the proxy to capture the file it triggers. */
async function exportWithCapture(
  ctx: RunContext,
  target: TargetSession,
  stage: 'export' | 'reexport',
  workspace: string,
  objective: string,
  url: string,
  tryIndex: number,
): Promise<StepOutcome<{ result: BrowserResult; file: CapturedFile }>> {
  const wait = target.capture.expectExport(stage, workspace);
  let result: BrowserResult;
  try {
    result = await runOnce(ctx, stage, objective, url, tryIndex);
  } catch (error) {
    wait.cancel();
    throw error;
  }
  if (result.outcome !== 'passed') {
    wait.cancel();
    return browserFailure(stage, result);
  }
  try {
    return { ok: true, value: { result, file: await wait.wait(CAPTURE_SETTLE_MS) } };
  } catch (error) {
    return {
      ok: false,
      stage,
      reason: `Kane finished but no complete file was captured (${error instanceof Error ? error.message : String(error)})`,
    };
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
  const extract = ctx.config.capture.extract;
  if (extract) return keepExtracted(ctx, file, kind, workspace, extract.entry);
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

/**
 * For apps that export a zip: keep the archive exactly as downloaded, then pull out the one CSV
 * the contract describes. The extracted file is what gets compared and restored, and its
 * provenance names the archive hash it came from.
 */
async function keepExtracted(
  ctx: RunContext,
  file: CapturedFile,
  kind: 'export' | 'reexport',
  workspace: string,
  entry: string,
): Promise<ArtifactRecord> {
  const archive = await ctx.store.importArtifact({
    runId: ctx.runId,
    attempt: ctx.attempt,
    kind: 'archive',
    fileName: `${kind}.zip`,
    sourcePath: file.path,
    mediaType: 'application/zip',
    expectedSha256: file.sha256,
    provenance: { capturedBy: 'returntrip-proxy', workspace, capturedAt: file.capturedAt },
  });
  let bytes: Buffer;
  try {
    bytes = parseZip(await ctx.store.readArtifact(archive), DEFAULT_ZIP_LIMITS).read(entry);
  } catch (error) {
    throw new RunStop(
      'EXECUTION_FAILED',
      'ARCHIVE_UNREADABLE',
      `The ${kind} archive did not contain a readable ${entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const artifact = await ctx.store.writeArtifact({
    runId: ctx.runId,
    attempt: ctx.attempt,
    kind,
    fileName: `${kind}.csv`,
    data: bytes,
    mediaType: 'text/csv',
    provenance: { extractedFrom: archive.id, archiveSha256: archive.sha256, entry, workspace },
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
  const workspaceUrl = (workspace: string): string =>
    fillPlaceholders(journey.workspaceUrl, { origin: target.origin, workspace });
  const base = {
    origin: target.origin,
    sourceUrl: workspaceUrl(journey.sourceWorkspace),
    expectedRows: sourceParsed.rowCount,
    expectedRowsGrouped: groupedNumber(sourceParsed.rowCount),
  };
  const browser: Partial<Record<BrowserStage, BrowserResult>> = {};

  const exported = await withRetries(ctx, 'export', (tryIndex) =>
    exportWithCapture(
      ctx,
      target,
      'export',
      journey.sourceWorkspace,
      fillPlaceholders(journey.export, base),
      base.sourceUrl,
      tryIndex,
    ),
  );
  browser.export = exported.result;
  const exportArtifact = await keepCapture(ctx, exported.file, 'export', journey.sourceWorkspace);
  ctx.store.updateRun(ctx.runId, { phase: 'EXPORT_CAPTURED' });

  // Creating the destination and restoring into it retry together: a retry always gets a brand
  // new empty workspace, so a half-finished import can never be counted twice.
  const restoreFile = ctx.store.artifactPath(exportArtifact);
  const restored = await withRetries<{ destination: string; destinationUrl: string }>(
    ctx,
    'restore into a new empty workspace',
    async (tryIndex) => {
      const destination =
        journey.destinationWorkspace ?? `restore-${ctx.attempt}-${randomBytes(3).toString('hex')}`;
      const values = {
        ...base,
        destinationName: destination,
        destinationUrl: workspaceUrl(destination),
        restoreFile,
      };
      const created = await runOnce(
        ctx,
        'create-destination',
        fillPlaceholders(journey.createDestination, values),
        `${target.origin}/`,
        tryIndex,
      );
      browser['create-destination'] = created;
      if (created.outcome !== 'passed') return browserFailure('create-destination', created);
      ctx.store.setAttemptDestination(ctx.runId, ctx.attempt, destination);

      const restoreWait = ctx.config.capture.restoreRoute
        ? target.capture.expectRestore('restore', destination)
        : null;
      let result: BrowserResult;
      try {
        result = await runOnce(
          ctx,
          'restore',
          fillPlaceholders(journey.restore, values),
          values.destinationUrl,
          tryIndex,
        );
      } catch (error) {
        restoreWait?.cancel();
        throw error;
      }
      browser.restore = result;
      if (result.outcome !== 'passed') {
        restoreWait?.cancel();
        // A generated destination is thrown away on retry. A seeded one is reused, so once the
        // restore step has run, a retry could import the same rows twice.
        return { ...browserFailure('restore', result), retryable: !journey.destinationWorkspace };
      }
      await verifyLineage(
        ctx,
        restoreWait ? await settle(restoreWait.wait(CAPTURE_SETTLE_MS), 'restore') : null,
        exportArtifact,
      );
      return { ok: true, value: { destination, destinationUrl: values.destinationUrl } };
    },
  );
  const destination = restored.destination;
  ctx.store.updateRun(ctx.runId, { phase: 'RESTORED' });

  const reexported = await withRetries(ctx, 're-export', (tryIndex) =>
    exportWithCapture(
      ctx,
      target,
      'reexport',
      destination,
      fillPlaceholders(journey.reexport, {
        ...base,
        destinationName: destination,
        destinationUrl: restored.destinationUrl,
      }),
      restored.destinationUrl,
      tryIndex,
    ),
  );
  browser.reexport = reexported.result;
  const reexportArtifact = await keepCapture(ctx, reexported.file, 'reexport', destination);
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
