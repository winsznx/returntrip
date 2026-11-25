import { EXIT_CODES, type RunMode } from '@returntrip/contracts';
import { ConfigError, executeRun, type LoadedConfig, loadConfig, realDeps } from '@returntrip/orchestrator';
import type { RunRecord, RunStore } from '@returntrip/storage';
import pc from 'picocolors';

import { confirm, DEFAULT_CONFIG, isInteractive, openStore } from '../context.ts';
import { type Output, outcomeBadge, renderDifferences, renderEvent } from '../render.ts';

export interface RunCommandOptions {
  readonly config?: string;
  readonly store?: string;
  readonly json?: boolean;
  readonly events?: boolean;
  readonly headless?: boolean;
  readonly yes?: boolean;
  readonly fromRun?: string;
}

function summarize(store: RunStore, run: RunRecord): Record<string, unknown> {
  const report = store.listArtifacts(run.id).find((artifact) => artifact.kind === 'report-json');
  return {
    runId: run.id,
    outcome: run.outcome,
    exitCode: run.outcome ? EXIT_CODES[run.outcome] : 1,
    headline: run.headline,
    failureCode: run.failureCode,
    attempts: run.activeAttempt,
    kaneCreditsUsed: run.kaneCreditsUsed,
    agentUsd: run.agentUsd,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    report: report ? store.artifactPath(report) : null,
  };
}

async function authorizeRepair(
  loaded: LoadedConfig,
  options: RunCommandOptions,
  out: Output,
): Promise<boolean> {
  const app = loaded.config.application;
  if (app.mode !== 'managed') return true;
  out.info(pc.bold('Repair scope'));
  out.info(`  Claude Code may edit, in a disposable copy only: ${app.repairPaths.join(', ')}`);
  out.info(
    `  Up to ${loaded.config.limits.maxRepairAttempts} attempts, $${loaded.config.repair.maxAgentBudgetUsd} agent budget, ${loaded.config.limits.maxKaneCredits} Kane credits.`,
  );
  out.info('  Nothing is merged, pushed or deployed. You get a patch to review.');
  if (options.yes) return true;
  if (!isInteractive()) {
    out.info(pc.red('Repair needs approval. Re-run with --yes in non-interactive environments.'));
    return false;
  }
  return confirm('Allow this repair?');
}

/** verify and repair share one path: same engine, same events, same exit codes. */
export async function runCommand(mode: RunMode, options: RunCommandOptions, out: Output): Promise<number> {
  if (options.json && options.events) {
    out.info('--json and --events are mutually exclusive.');
    return EXIT_CODES.INVALID_CONFIG;
  }
  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig(options.config ?? DEFAULT_CONFIG);
  } catch (error) {
    out.info(pc.red(error instanceof ConfigError ? error.message : String(error)));
    if (options.json) out.data(`${JSON.stringify({ outcome: 'INVALID_CONFIG', error: String(error) })}\n`);
    return EXIT_CODES.INVALID_CONFIG;
  }
  if (mode === 'repair' && !(await authorizeRepair(loaded, options, out))) return EXIT_CODES.INVALID_CONFIG;

  const store = await openStore(loaded, options.store);
  if (options.fromRun) {
    const previous = store.getRun(options.fromRun);
    if (!previous) {
      out.info(pc.red(`No run ${options.fromRun} in ${store.root}.`));
      store.close();
      return EXIT_CODES.INVALID_CONFIG;
    }
    if (previous.configHash !== loaded.configHash) {
      out.info(
        pc.red(`Run ${options.fromRun} used a different config; repair from a fresh verification instead.`),
      );
      store.close();
      return EXIT_CODES.INVALID_CONFIG;
    }
    out.info(
      pc.dim(
        `Run ${options.fromRun} matches this config. The repair starts with a fresh verification so the agent sees current evidence.`,
      ),
    );
  }

  const controller = new AbortController();
  const onSignal = (): void => {
    out.info(pc.yellow('\nCanceling: stopping Kane, the target and the agent…'));
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let unsubscribe = (): void => undefined;
  try {
    const app = loaded.config.application;
    if (app.mode === 'managed' && app.scenario)
      out.info(pc.yellow(`⚑ ${app.scenario.disclosure} (${app.scenario.name})`));
    const finished = await executeRun({
      store,
      loaded,
      mode,
      deps: realDeps({ headless: Boolean(options.headless) }),
      options: { headless: Boolean(options.headless) },
      signal: controller.signal,
      ...(options.fromRun ? { fromRunId: options.fromRun } : {}),
      onCreated: (run) => {
        if (!options.json) out.info(pc.dim(`Run ${run.id}`));
        unsubscribe = store.subscribe(run.id, (event) => {
          if (options.events) out.data(`${JSON.stringify(event)}\n`);
          else if (!options.json) {
            const line = renderEvent(event);
            if (line) out.info(line);
          }
        });
      },
    });
    unsubscribe();
    const outcome = finished.outcome ?? 'EXECUTION_FAILED';
    if (options.json) {
      out.data(`${JSON.stringify(summarize(store, finished), null, 2)}\n`);
    } else if (!options.events) {
      out.info('');
      out.info(`${outcomeBadge(outcome)}  ${finished.headline ?? ''}`);
      const comparison = store
        .listComparisons(finished.id)
        .filter((c) => c.attempt === 1 && !c.summary.isEquivalent)
        .find((c) => c.summary.edge === 'source_reexport');
      if (comparison) {
        const page = store.listDifferences(finished.id, { attempt: 1, edge: comparison.edge, limit: 5 });
        for (const line of renderDifferences(page.differences, page.total)) out.info(line);
      }
      const report = store.listArtifacts(finished.id).find((a) => a.kind === 'report-markdown');
      if (report) out.info(pc.dim(`Report: ${store.artifactPath(report)}`));
      out.info(
        pc.dim(
          `Kane credits: ${finished.kaneCreditsUsed.toFixed(1)}${finished.agentUsd > 0 ? `, agent: $${finished.agentUsd.toFixed(2)}` : ''}`,
        ),
      );
      out.info(
        pc.dim(`Inspect: returntrip runs show ${finished.id}   Replay: returntrip replay ${finished.id}`),
      );
    }
    return EXIT_CODES[outcome];
  } catch (error) {
    out.info(pc.red(error instanceof Error ? error.message : String(error)));
    return EXIT_CODES.EXECUTION_FAILED;
  } finally {
    unsubscribe();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    store.close();
  }
}
