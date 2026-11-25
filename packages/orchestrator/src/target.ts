import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  allocatePort,
  type PlaceholderValues,
  prepareTargetCopy,
  type RunningTarget,
  runStep,
  startTarget,
  type TargetCopy,
  waitForHealth,
} from '@returntrip/target-runtime';

import type { RunContext } from './context.ts';
import { RunStop } from './errors.ts';
import type { CaptureSession } from './ports.ts';

/** A running target behind the capture proxy, for exactly one verification attempt. */
export interface TargetSession {
  /** Proxy origin: the only address the browser is given. */
  readonly origin: string;
  readonly upstream: string;
  readonly capture: CaptureSession;
  stop(): Promise<void>;
}

export async function prepareCopy(ctx: RunContext): Promise<TargetCopy> {
  const app = ctx.config.application;
  if (app.mode !== 'managed' || !ctx.loaded.paths.appDir) throw new Error('only managed targets have copies');
  return prepareTargetCopy({
    appDir: ctx.loaded.paths.appDir,
    parentDir: join(ctx.workDir, 'copies'),
    label: `attempt-${ctx.attempt}`,
    ...(ctx.loaded.paths.scenarioPatch ? { scenarioPatch: ctx.loaded.paths.scenarioPatch } : {}),
  });
}

/**
 * Starts a fresh instance of the target with an empty data directory, seeds the trusted source
 * through the configured seed command (never through the importer under test), and puts the
 * capture proxy in front of it.
 */
export async function bootTarget(ctx: RunContext, copy: TargetCopy | null): Promise<TargetSession> {
  ctx.throwIfCanceled();
  const app = ctx.config.application;
  const logDir = ctx.store.runDir(ctx.runId);
  const values: Record<string, string | number> = {
    sourceCsv: ctx.loaded.paths.source,
    sourceWorkspace: ctx.config.journey.sourceWorkspace,
  };

  let running: RunningTarget | null = null;
  let dataDir: string | null = null;
  let upstream: string;

  try {
    if (app.mode === 'managed') {
      if (!copy) throw new Error('managed target needs a copy');
      dataDir = await mkdtemp(join(ctx.workDir, `data-${ctx.attempt}-`));
      const port = await allocatePort();
      const filled: PlaceholderValues = { ...values, dataDir, port, appDir: copy.dir };
      const stepLog = join(logDir, `target-${ctx.attempt}.log`);
      if (app.lifecycle.build) {
        const started = performance.now();
        try {
          await runStep({
            name: 'build',
            dir: copy.dir,
            argv: app.lifecycle.build,
            env: app.lifecycle.env,
            values: filled,
            timeoutMs: 600_000,
            logPath: stepLog,
            signal: ctx.signal,
          });
          ctx.emit('build.finished', { ok: true, durationMs: performance.now() - started });
        } catch (error) {
          ctx.emit('build.finished', { ok: false, durationMs: performance.now() - started });
          throw error;
        }
      }
      if (app.lifecycle.seed) {
        await runStep({
          name: 'seed',
          dir: copy.dir,
          argv: app.lifecycle.seed,
          env: app.lifecycle.env,
          values: filled,
          timeoutMs: 120_000,
          logPath: stepLog,
          signal: ctx.signal,
        });
      }
      running = await startTarget({
        dir: copy.dir,
        argv: app.lifecycle.start,
        env: app.lifecycle.env,
        values: filled,
        port,
        healthPath: app.lifecycle.healthPath,
        startupTimeoutMs: app.lifecycle.startupTimeoutMs,
        logPath: stepLog,
        signal: ctx.signal,
      });
      upstream = running.origin;
    } else {
      upstream = app.origin.replace(/\/$/, '');
      await waitForHealth({
        url: `${upstream}${app.lifecycle.healthPath}`,
        timeoutMs: 15_000,
        signal: ctx.signal,
      });
      if (app.lifecycle.seed) {
        await runStep({
          name: 'seed',
          dir: ctx.loaded.configDir,
          argv: app.lifecycle.seed,
          env: {},
          values: { ...values, origin: upstream },
          timeoutMs: 300_000,
          logPath: join(logDir, `target-${ctx.attempt}.log`),
          signal: ctx.signal,
        });
      }
    }

    const capture = await ctx.deps.capture.start({
      upstream,
      capture: ctx.config.capture,
      artifactDir: join(ctx.workDir, `capture-${ctx.attempt}`),
    });
    const stoppable = running;
    const ownedData = dataDir;
    const attempt = ctx.attempt;
    return {
      origin: capture.origin,
      upstream,
      capture,
      async stop() {
        // The proxy's request log (method, path, status, timing; never headers or bodies) is the
        // record of what the browser actually fetched during this attempt.
        await ctx.store
          .writeArtifact({
            runId: ctx.runId,
            attempt,
            kind: 'proxy-log',
            fileName: 'proxy-requests.json',
            data: `${JSON.stringify(capture.requestLog(), null, 2)}\n`,
            mediaType: 'application/json',
          })
          .catch((error: unknown) => {
            ctx.emit('warning', {
              code: 'PROXY_LOG_FAILED',
              message: `Could not keep the proxy request log: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
        await capture.close();
        await stoppable?.stop();
        if (ownedData) await rm(ownedData, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await running?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (error instanceof RunStop) throw error;
    ctx.throwIfCanceled();
    throw new RunStop(
      'EXECUTION_FAILED',
      'TARGET_START',
      `The target app did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
