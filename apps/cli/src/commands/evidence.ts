import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { EXIT_CODES } from '@returntrip/contracts';
import { loadConfig, scenarioOf } from '@returntrip/orchestrator';
import { exportPublicBundle } from '@returntrip/reporting';
import pc from 'picocolors';

import { loadOptionalConfig, openStore } from '../context.ts';
import type { Output } from '../render.ts';

async function currentCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Writes a sanitized, static copy of one run for the public viewer. Only allowlisted files are
 * copied; Kane's evidence packs stay private because they carry account details.
 */
export async function exportEvidence(
  id: string,
  options: { config?: string; store?: string; out: string; public?: boolean },
  out: Output,
): Promise<number> {
  if (!options.public) {
    out.info(pc.red('Only --public bundles can be exported. Private evidence stays in the run store.'));
    return EXIT_CODES.INVALID_CONFIG;
  }
  const store = await openStore(await loadOptionalConfig(options.config), options.store);
  try {
    const run = store.getRun(id);
    if (!run) {
      out.info(pc.red(`No run ${id}.`));
      return EXIT_CODES.INVALID_CONFIG;
    }
    if (run.status !== 'finished') {
      out.info(pc.red('Only finished runs can be exported.'));
      return EXIT_CODES.INVALID_CONFIG;
    }
    const loaded = await loadConfig(run.configPath).catch(() => null);
    const { dir, run: bundle } = await exportPublicBundle({
      store,
      runId: id,
      outDir: resolve(options.out),
      scenario: loaded ? scenarioOf(loaded) : null,
      commit: await currentCommit(process.cwd()),
    });
    out.info(`Wrote ${dir}`);
    out.info(
      pc.dim(
        `${bundle.files.length} files, ${bundle.screenshots.length} screenshots. Review them before publishing.`,
      ),
    );
    return 0;
  } finally {
    store.close();
  }
}
