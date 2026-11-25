import { readFileSync } from 'node:fs';

import { Command, Option } from 'commander';

import { doctor } from './commands/doctor.ts';
import { exportEvidence } from './commands/evidence.ts';
import { init } from './commands/init.ts';
import { replay } from './commands/replay.ts';
import { runCommand } from './commands/run.ts';
import { cancelRun, deleteRun, exportReport, listRuns, showRun } from './commands/runs.ts';
import { consoleOutput, type Output } from './render.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Builds the CLI. Every action resolves to an exit code; nothing calls process.exit directly. */
export function buildProgram(out: Output, setExit: (code: number) => void): Command {
  const program = new Command('returntrip')
    .description('Prove your app gives back the data it exported.')
    .version(pkg.version)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => out.info(text.trimEnd()),
      writeErr: (text) => out.info(text.trimEnd()),
    });

  const config = (): Option => new Option('-c, --config <path>', 'config file').default('returntrip.yaml');
  const store = (): Option =>
    new Option('--store <dir>', 'run store directory (default: <project>/.returntrip)');
  const act =
    <A extends unknown[]>(work: (...args: A) => Promise<number>) =>
    async (...args: A): Promise<void> => {
      setExit(await work(...args));
    };

  program
    .command('doctor')
    .description('check Node, Kane CLI, credits, Claude Code and the config; spends nothing')
    .addOption(config())
    .option('--json', 'machine-readable output')
    .action(act((options: { config: string; json?: boolean }) => doctor(options, out)));

  program
    .command('init')
    .description('write a starter returntrip.yaml with the source pinned and a suggested contract')
    .requiredOption('--source <csv>', 'trusted source CSV')
    .option('--app-dir <dir>', 'your app directory, if ReturnTrip should start it')
    .option('--origin <url>', 'your running app on loopback, for verify-only use')
    .option('--project <name>', 'project name')
    .option('-o, --out <path>', 'where to write the config', 'returntrip.yaml')
    .option('--force', 'overwrite an existing config')
    .option('-y, --yes', 'write without asking')
    .action(act((options: Parameters<typeof init>[0]) => init(options, out)));

  for (const mode of ['verify', 'repair'] as const) {
    const command = program
      .command(mode)
      .description(
        mode === 'verify'
          ? 'export, restore and re-export through Kane, then compare every record; never edits code'
          : 'verify, and if data changed, let Claude Code patch a disposable copy and verify again',
      )
      .addOption(config())
      .addOption(store())
      .option('--json', 'print one final JSON result on stdout')
      .option('--events', 'stream NDJSON run events on stdout')
      .option('--headless', 'run Chrome without a window');
    if (mode === 'repair') {
      command.option('--from-run <id>', 'start from a previous mismatch with the same config');
      command.option('-y, --yes', 'approve the repair scope without asking');
    }
    command.action(act((options: Parameters<typeof runCommand>[1]) => runCommand(mode, options, out)));
  }

  const runs = program.command('runs').description('list, inspect and delete stored runs');
  runs
    .command('list')
    .addOption(config())
    .addOption(store())
    .option('--limit <n>', 'how many', '20')
    .option('--json', 'machine-readable output')
    .action(act((options: Parameters<typeof listRuns>[0]) => listRuns(options, out)));
  runs
    .command('show <id>')
    .addOption(config())
    .addOption(store())
    .option('--json', 'machine-readable output')
    .action(act((id: string, options: Parameters<typeof showRun>[1]) => showRun(id, options, out)));
  runs
    .command('delete <id>')
    .addOption(config())
    .addOption(store())
    .option('-y, --yes', 'delete without asking')
    .action(act((id: string, options: Parameters<typeof deleteRun>[1]) => deleteRun(id, options, out)));

  program
    .command('report <id>')
    .description('write a run report as JSON or Markdown')
    .addOption(config())
    .addOption(store())
    .addOption(new Option('--format <format>', 'output format').choices(['json', 'markdown']).default('json'))
    .option('-o, --out <path>', 'file to write (refuses to overwrite)')
    .action(act((id: string, options: Parameters<typeof exportReport>[1]) => exportReport(id, options, out)));

  program
    .command('replay <id>')
    .description('run a past run again, as a new run, with the identical config')
    .addOption(config())
    .addOption(store())
    .option('--json', 'print one final JSON result on stdout')
    .option('--events', 'stream NDJSON run events on stdout')
    .option('--headless', 'run Chrome without a window')
    .option('-y, --yes', 'approve a repair replay without asking')
    .action(act((id: string, options: Parameters<typeof replay>[1]) => replay(id, options, out)));

  program
    .command('evidence')
    .description('export a sanitized copy of a finished run for the public viewer')
    .command('export <id>')
    .addOption(config())
    .addOption(store())
    .requiredOption('-o, --out <dir>', 'bundle directory, e.g. apps/dashboard/public/evidence')
    .option('--public', 'confirm this bundle is meant to be published')
    .action(
      act((id: string, options: Parameters<typeof exportEvidence>[1]) => exportEvidence(id, options, out)),
    );

  program
    .command('cancel <id>')
    .description('cancel an active run started from another terminal')
    .addOption(config())
    .addOption(store())
    .action(act((id: string, options: Parameters<typeof cancelRun>[1]) => cancelRun(id, options, out)));

  return program;
}

export async function main(argv: readonly string[], out: Output = consoleOutput): Promise<number> {
  let code = 0;
  const program = buildProgram(out, (value) => {
    code = value;
  });
  program.exitOverride();
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    return typeof exitCode === 'number' ? exitCode : 1;
  }
  return code;
}
