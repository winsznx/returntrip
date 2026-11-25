import { EXIT_CODES } from '@returntrip/contracts';
import { loadConfig } from '@returntrip/orchestrator';
import pc from 'picocolors';

import { loadOptionalConfig, openStore } from '../context.ts';
import type { Output } from '../render.ts';
import { runCommand } from './run.ts';

/**
 * Re-runs a past run's exact config as a brand-new run. Refuses if the config file changed since,
 * because then it wouldn't be a replay.
 */
export async function replay(
  id: string,
  options: {
    config?: string;
    store?: string;
    json?: boolean;
    events?: boolean;
    headless?: boolean;
    yes?: boolean;
  },
  out: Output,
): Promise<number> {
  const store = await openStore(await loadOptionalConfig(options.config), options.store);
  const previous = store.getRun(id);
  const root = store.root;
  store.close();
  if (!previous) {
    out.info(pc.red(`No run ${id} in ${root}.`));
    return EXIT_CODES.INVALID_CONFIG;
  }
  const current = await loadConfig(previous.configPath);
  if (current.configHash !== previous.configHash) {
    out.info(pc.red(`${previous.configPath} changed since run ${id}; a replay must use the same config.`));
    return EXIT_CODES.INVALID_CONFIG;
  }
  out.info(pc.dim(`Replaying run ${id} (${previous.mode}) as a new run with the same config.`));
  return runCommand(
    previous.mode,
    { ...options, config: previous.configPath, store: root, fromRun: id },
    out,
  );
}
