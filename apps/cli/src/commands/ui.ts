import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { EXIT_CODES } from '@returntrip/contracts';
import { realDeps } from '@returntrip/orchestrator';
import { buildServer, RunManager } from '@returntrip/server';
import pc from 'picocolors';

import { loadOptionalConfig, openStore } from '../context.ts';
import type { Output } from '../render.ts';

const DASHBOARD_DIST = fileURLToPath(new URL('../../../dashboard/dist', import.meta.url));

/**
 * Starts the loopback API and dashboard. The printed link carries a one-time token in the URL
 * fragment, which browsers never send to the server or write to its logs.
 */
export async function ui(
  options: { config: string[]; store?: string; port?: string; headless?: boolean },
  out: Output,
): Promise<number> {
  const configs = options.config.length > 0 ? options.config : ['returntrip.yaml'];
  const first = await loadOptionalConfig(configs[0]);
  if (!first) {
    out.info(
      pc.red(`Could not load ${configs[0]}. Run returntrip doctor --config ${configs[0]} for details.`),
    );
    return EXIT_CODES.INVALID_CONFIG;
  }
  const port = Number(options.port ?? 4320);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    out.info(pc.red('--port must be between 1024 and 65535.'));
    return EXIT_CODES.INVALID_CONFIG;
  }
  const hasDashboard = await stat(DASHBOARD_DIST).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const store = await openStore(first, options.store);
  const runs = await RunManager.create(
    store,
    realDeps({ headless: Boolean(options.headless) }),
    configs,
    Boolean(options.headless),
  );
  const { app, auth } = await buildServer({
    store,
    runs,
    port,
    version: '0.1.0',
    ...(hasDashboard ? { staticDir: DASHBOARD_DIST } : {}),
  });
  await app.listen({ host: '127.0.0.1', port });
  out.info(pc.green(`ReturnTrip is running on http://127.0.0.1:${port}`));
  out.info(`Open: ${pc.bold(`http://127.0.0.1:${port}/#token=${auth.bootstrapToken}`)}`);
  if (!hasDashboard)
    out.info(pc.yellow('Dashboard not built yet: pnpm --filter @returntrip/dashboard build. The API is up.'));
  out.info(pc.dim(`${runs.projects().length} project(s), runs stored in ${store.root}. Ctrl+C to stop.`));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  out.info(pc.dim('Stopping: canceling active runs…'));
  await runs.shutdown();
  await app.close();
  store.close();
  return 0;
}
