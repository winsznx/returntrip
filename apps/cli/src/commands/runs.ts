import { readFile, writeFile } from 'node:fs/promises';

import { EXIT_CODES } from '@returntrip/contracts';
import { buildRunReport, renderMarkdown } from '@returntrip/reporting';
import type { RunStore } from '@returntrip/storage';
import pc from 'picocolors';

import { confirm, isInteractive, loadOptionalConfig, openStore } from '../context.ts';
import { type Output, outcomeBadge } from '../render.ts';

interface StoreOptions {
  readonly config?: string;
  readonly store?: string;
  readonly json?: boolean;
}

async function withStore<T>(options: StoreOptions, work: (store: RunStore) => Promise<T> | T): Promise<T> {
  const store = await openStore(await loadOptionalConfig(options.config), options.store);
  try {
    return await work(store);
  } finally {
    store.close();
  }
}

function age(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export async function listRuns(options: StoreOptions & { limit?: string }, out: Output): Promise<number> {
  return withStore(options, (store) => {
    const page = store.listRuns({ limit: Number(options.limit ?? 20) });
    if (options.json) {
      out.data(`${JSON.stringify(page, null, 2)}\n`);
      return 0;
    }
    if (page.runs.length === 0) {
      out.info(`No runs yet in ${store.root}. Start one with: returntrip verify`);
      return 0;
    }
    for (const run of page.runs) {
      const status = run.outcome ? outcomeBadge(run.outcome) : pc.cyan('RUNNING');
      out.info(
        `${pc.dim(run.id)}  ${status.padEnd(30)} ${pc.dim(age(run.startedAt).padEnd(8))} ${run.mode.padEnd(6)} ${run.headline ?? run.phase}`,
      );
    }
    return 0;
  });
}

export async function showRun(id: string, options: StoreOptions, out: Output): Promise<number> {
  return withStore(options, (store) => {
    const run = store.getRun(id);
    if (!run) {
      out.info(pc.red(`No run ${id}.`));
      return EXIT_CODES.INVALID_CONFIG;
    }
    const report = buildRunReport(store, id);
    if (options.json) {
      out.data(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    out.info(renderMarkdown(report));
    return 0;
  });
}

export async function exportReport(
  id: string,
  options: StoreOptions & { format?: string; out?: string },
  out: Output,
): Promise<number> {
  return withStore(options, async (store) => {
    if (!store.getRun(id)) {
      out.info(pc.red(`No run ${id}.`));
      return EXIT_CODES.INVALID_CONFIG;
    }
    const report = buildRunReport(store, id);
    const text =
      options.format === 'markdown' ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) {
      await writeFile(options.out, text, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new Error(`${options.out} already exists; choose another path.`);
        throw error;
      });
      out.info(`Wrote ${options.out}`);
    } else {
      out.data(text);
    }
    return 0;
  });
}

export async function deleteRun(
  id: string,
  options: StoreOptions & { yes?: boolean },
  out: Output,
): Promise<number> {
  return withStore(options, async (store) => {
    const run = store.getRun(id);
    if (!run) {
      out.info(pc.red(`No run ${id}.`));
      return EXIT_CODES.INVALID_CONFIG;
    }
    if (!options.yes) {
      if (!isInteractive()) {
        out.info('Deleting needs --yes in non-interactive environments.');
        return EXIT_CODES.INVALID_CONFIG;
      }
      if (!(await confirm(`Delete run ${id} and all its evidence?`))) return 0;
    }
    await store.deleteRun(id);
    out.info(`Deleted run ${id}.`);
    return 0;
  });
}

/** Cancels a run started by another returntrip process by signalling the process holding its lock. */
export async function cancelRun(id: string, options: StoreOptions, out: Output): Promise<number> {
  return withStore(options, async (store) => {
    const run = store.getRun(id);
    if (!run) {
      out.info(pc.red(`No run ${id}.`));
      return EXIT_CODES.INVALID_CONFIG;
    }
    if (run.status !== 'active') {
      out.info(`Run ${id} already finished (${run.outcome ?? 'no outcome'}).`);
      return 0;
    }
    const lock = JSON.parse(
      await readFile(`${store.root}/locks/${run.project}.lock`, 'utf8').catch(() => '{}'),
    ) as { pid?: number };
    if (typeof lock.pid !== 'number') {
      out.info(pc.yellow(`Run ${id} has no live owner; it will be marked interrupted on next start.`));
      return EXIT_CODES.EXECUTION_FAILED;
    }
    process.kill(lock.pid, 'SIGINT');
    out.info(`Asked process ${lock.pid} to cancel run ${id}.`);
    return 0;
  });
}
