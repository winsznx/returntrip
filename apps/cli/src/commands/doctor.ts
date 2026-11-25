import { statfs } from 'node:fs/promises';

import { EXIT_CODES } from '@returntrip/contracts';
import { getKaneBalance, getKaneVersion, VERIFIED_KANE_VERSIONS } from '@returntrip/kane-adapter';
import { ConfigError, loadConfig, readPinnedSource } from '@returntrip/orchestrator';
import { getClaudeVersion } from '@returntrip/repair-agent';
import pc from 'picocolors';

import { DEFAULT_CONFIG } from '../context.ts';
import type { Output } from '../render.ts';

interface Check {
  readonly name: string;
  readonly ok: boolean | 'warn';
  readonly detail: string;
  readonly fix?: string;
}

/** Read-only readiness checks. Spends no credits and never touches the target. */
export async function doctor(options: { config?: string; json?: boolean }, out: Output): Promise<number> {
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({
    name: 'Node.js',
    ok: Number(node.split('.')[0]) >= 24,
    detail: node,
    fix: 'Install Node.js 24 or newer.',
  });

  const kane = await getKaneVersion();
  checks.push({
    name: 'Kane CLI',
    ok: kane === null ? false : VERIFIED_KANE_VERSIONS.includes(kane) ? true : 'warn',
    detail: kane
      ? `${kane}${VERIFIED_KANE_VERSIONS.includes(kane) ? '' : ` (verified with ${VERIFIED_KANE_VERSIONS.join(', ')})`}`
      : 'not found',
    fix: 'npm install -g @testmuai/kane-cli && kane-cli login --oauth',
  });
  if (kane) {
    const balance = await getKaneBalance();
    checks.push({
      name: 'Kane credits',
      ok: balance === null ? false : balance >= 120 ? true : 'warn',
      detail: balance === null ? 'not signed in or balance unavailable' : `${balance} available`,
      fix: 'kane-cli login --oauth',
    });
  }

  const claude = await getClaudeVersion();
  checks.push({
    name: 'Claude Code (repair only)',
    ok: claude ? true : 'warn',
    detail: claude ?? 'not found',
    fix: 'Install Claude Code to use returntrip repair.',
  });

  const disk = await statfs(process.cwd());
  const freeGb = (disk.bavail * disk.bsize) / 1024 ** 3;
  checks.push({ name: 'Free disk', ok: freeGb > 1, detail: `${freeGb.toFixed(1)} GB` });

  try {
    const loaded = await loadConfig(options.config ?? DEFAULT_CONFIG);
    checks.push({ name: 'Config', ok: true, detail: loaded.configPath });
    await readPinnedSource(loaded);
    checks.push({ name: 'Trusted source hash', ok: true, detail: loaded.config.source.sha256.slice(0, 16) });
    const app = loaded.config.application;
    checks.push({
      name: 'Target',
      ok: true,
      detail:
        app.mode === 'managed' ? `managed, ${loaded.paths.appDir}` : `attached, ${app.origin} (verify only)`,
    });
    if (app.mode === 'managed' && app.scenario) {
      checks.push({
        name: 'Scenario',
        ok: 'warn',
        detail: `${app.scenario.name}: ${app.scenario.disclosure}`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'Config',
      ok: false,
      detail: error instanceof ConfigError ? error.message : String(error),
      fix: 'returntrip init --source <file.csv>',
    });
  }

  if (options.json) {
    out.data(`${JSON.stringify({ checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const mark = check.ok === true ? pc.green('✓') : check.ok === 'warn' ? pc.yellow('!') : pc.red('✗');
      out.info(`${mark} ${check.name.padEnd(26)} ${check.detail}`);
      if (check.ok !== true && check.fix) out.info(pc.dim(`  ${check.fix}`));
    }
  }
  return checks.some((check) => check.ok === false) ? EXIT_CODES.INVALID_CONFIG : 0;
}
