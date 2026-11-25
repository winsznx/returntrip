import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  allocatePort,
  diffAgainst,
  execArgv,
  fillArgv,
  fillPlaceholders,
  hashTree,
  minimalEnv,
  prepareTargetCopy,
  rawChangesAgainst,
  restoreTree,
  runStep,
  startTarget,
} from '../src/index.ts';

const SERVER_SOURCE = `
import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  res.end(process.env.GREETING ?? 'none');
});
server.listen(Number(process.argv[2]), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

describe('placeholders', () => {
  it('fills known placeholders in argv tokens', () => {
    // #given
    const argv = ['node', 'server.js', '--port', '{port}', '--data={dataDir}'];

    // #when
    const filled = fillArgv(argv, { port: 4311, dataDir: '/tmp/d' });

    // #then
    expect(filled).toEqual(['node', 'server.js', '--port', '4311', '--data=/tmp/d']);
  });

  it('refuses an unknown placeholder instead of passing it through literally', () => {
    // #given
    const template = 'open {sourceUrl} then {destinationUrl}';

    // #when
    const fill = (): string => fillPlaceholders(template, { sourceUrl: 'http://x' });

    // #then
    expect(fill).toThrow(/unknown placeholder \{destinationUrl\}/);
  });
});

describe('execArgv', () => {
  it('passes only allowlisted environment variables to the child', async () => {
    // #given
    process.env.RETURNTRIP_TEST_SECRET = 'leak';
    const env = minimalEnv({ VISIBLE: 'yes' });

    // #when
    const result = await execArgv(
      [
        'node',
        '-e',
        'process.stdout.write(JSON.stringify([process.env.VISIBLE, process.env.RETURNTRIP_TEST_SECRET]))',
      ],
      { cwd: tmpdir(), env, timeoutMs: 10_000 },
    );

    // #then
    expect(JSON.parse(result.stdout)).toEqual(['yes', null]);
    delete process.env.RETURNTRIP_TEST_SECRET;
  });

  it('kills a command that runs past its timeout', async () => {
    // #given
    const argv = ['node', '-e', 'setTimeout(() => {}, 60_000)'];

    // #when
    const result = await execArgv(argv, { cwd: tmpdir(), env: minimalEnv(), timeoutMs: 300 });

    // #then
    expect(result.timedOut).toBe(true);
  });

  it('never interprets shell syntax in arguments', async () => {
    // #given
    const argv = ['node', '-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); rm -rf /'];

    // #when
    const result = await execArgv(argv, { cwd: tmpdir(), env: minimalEnv(), timeoutMs: 10_000 });

    // #then
    expect(result.stdout).toBe('$(echo pwned); rm -rf /');
  });
});

describe('target copies', () => {
  let parent: string;
  let appDir: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'returntrip-runtime-'));
    appDir = join(parent, 'app');
    await mkdir(join(appDir, 'src'), { recursive: true });
    await mkdir(join(appDir, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(appDir, 'src', 'export.js'), 'export const order = ["date", "amount"];\n');
    await writeFile(join(appDir, 'node_modules', 'dep', 'index.js'), 'big dependency');
    await writeFile(join(appDir, 'server.mjs'), SERVER_SOURCE);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('copies the app without node_modules and leaves the original untouched', async () => {
    // #given
    const before = await hashTree(appDir, ['src']);

    // #when
    const copy = await prepareTargetCopy({ appDir, parentDir: join(parent, 'copies'), label: 'demo' });
    await writeFile(join(copy.dir, 'src', 'export.js'), 'changed');

    // #then
    expect({
      original: await hashTree(appDir, ['src']),
      copied: await hashTree(copy.dir, ['node_modules']),
    }).toEqual({ original: before, copied: {} });
  });

  it('applies a scenario patch and snapshots the patched tree as the base', async () => {
    // #given
    const patchPath = join(parent, 'swap.patch');
    await writeFile(
      patchPath,
      [
        'diff --git a/src/export.js b/src/export.js',
        '--- a/src/export.js',
        '+++ b/src/export.js',
        '@@ -1 +1 @@',
        '-export const order = ["date", "amount"];',
        '+export const order = ["amount", "date"];',
        '',
      ].join('\n'),
    );

    // #when
    const copy = await prepareTargetCopy({
      appDir,
      parentDir: join(parent, 'copies'),
      label: 'demo',
      scenarioPatch: patchPath,
    });

    // #then
    expect({
      file: await readFile(join(copy.dir, 'src', 'export.js'), 'utf8'),
      diff: await diffAgainst(copy.dir, copy.baseTree),
    }).toEqual({ file: 'export const order = ["amount", "date"];\n', diff: '' });
  });

  it('reports edits, new files and symlinks made after the snapshot', async () => {
    // #given
    const copy = await prepareTargetCopy({ appDir, parentDir: join(parent, 'copies'), label: 'demo' });
    await writeFile(join(copy.dir, 'src', 'export.js'), 'export const order = [];\n');
    await writeFile(join(copy.dir, 'src', 'new.js'), 'new\n');
    await symlink('/etc/passwd', join(copy.dir, 'src', 'link'));

    // #when
    const changes = await rawChangesAgainst(copy.dir, copy.baseTree);

    // #then
    expect(changes.map(({ path, newMode, status }) => [path, newMode, status]).sort()).toEqual([
      ['src/export.js', '100644', 'M'],
      ['src/link', '120000', 'A'],
      ['src/new.js', '100644', 'A'],
    ]);
  });

  it('restores the working copy to its snapshot', async () => {
    // #given
    const copy = await prepareTargetCopy({ appDir, parentDir: join(parent, 'copies'), label: 'demo' });
    await writeFile(join(copy.dir, 'src', 'export.js'), 'broken');
    await writeFile(join(copy.dir, 'src', 'stray.js'), 'stray');

    // #when
    await restoreTree(copy.dir, copy.baseTree);

    // #then
    expect(await diffAgainst(copy.dir, copy.baseTree)).toBe('');
  });

  it('starts a managed target, waits for health and stops its process group', async () => {
    // #given
    const port = await allocatePort();
    const target = await startTarget({
      dir: appDir,
      argv: ['node', 'server.mjs', '{port}'],
      env: { GREETING: 'hello from {port}' },
      values: { port },
      port,
      healthPath: '/health',
      startupTimeoutMs: 10_000,
      logPath: join(parent, 'target.log'),
    });

    // #when
    const body = await (await fetch(`${target.origin}/`)).text();
    await target.stop();

    // #then
    expect({ body, alive: target.isAlive() }).toEqual({ body: `hello from ${port}`, alive: false });
  });

  it('fails fast when the target exits before becoming healthy', async () => {
    // #given
    const port = await allocatePort();

    // #when
    const start = startTarget({
      dir: appDir,
      argv: ['node', '-e', 'process.exit(3)'],
      env: {},
      values: {},
      port,
      healthPath: '/health',
      startupTimeoutMs: 10_000,
      logPath: join(parent, 'target.log'),
    });

    // #then
    await expect(start).rejects.toThrow(/exited before it became healthy/);
  });

  it('surfaces the tail of a failing step', async () => {
    // #given
    const argv = ['node', '-e', 'console.error("seed: header mismatch"); process.exit(2)'];

    // #when
    const step = runStep({
      name: 'seed',
      dir: appDir,
      argv,
      env: {},
      values: {},
      timeoutMs: 10_000,
      logPath: join(parent, 'seed.log'),
    });

    // #then
    await expect(step).rejects.toThrow(/seed exited with code 2: seed: header mismatch/);
  });
});
