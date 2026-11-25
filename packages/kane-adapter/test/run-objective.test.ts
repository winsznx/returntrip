import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type KaneProgress, type KaneRunOptions, runKaneObjective } from '../src/run-objective.ts';
import { FAKE_KANE, fixturePath } from './support/fixtures.ts';

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kane-adapter-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function options(env: Record<string, string>, overrides: Partial<KaneRunOptions> = {}): KaneRunOptions {
  return {
    objective: 'Open the source workspace and verify it shows 3 records',
    url: 'http://127.0.0.1:4100/w/source',
    timeoutMs: 30_000,
    headless: true,
    cwd: workDir,
    logDir: join(workDir, 'logs'),
    kaneBin: FAKE_KANE,
    env,
    ...overrides,
  };
}

function replay(run: 'pf02-1-pass' | 'pf02-2-fail', exitCode: number): Record<string, string> {
  return {
    FAKE_KANE_STDOUT: fixturePath(run, 'ndjson'),
    FAKE_KANE_STDERR: fixturePath(run, 'stderr'),
    FAKE_KANE_EXIT: String(exitCode),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

describe('runKaneObjective against the fake-kane test double', () => {
  it('normalizes a replayed passing run delivered in 7-byte writes', async () => {
    // #given the fake replaying pf02-1 in tiny chunks and exiting 0
    const env = { ...replay('pf02-1-pass', 0), FAKE_KANE_CHUNK_BYTES: '7' };

    // #when the objective runs
    const { result } = await runKaneObjective(options(env));

    // #then the result is the same as for the captured run
    expect([result.outcome, result.creditsUsed, result.steps.length, result.protocolWarnings]).toEqual([
      'passed',
      14.6040625,
      3,
      [],
    ]);
  });

  it('writes stdout and stderr to the log directory byte for byte', async () => {
    // #given the fake replaying pf02-2
    const env = { ...replay('pf02-2-fail', 1), FAKE_KANE_CHUNK_BYTES: '13' };

    // #when the objective runs
    const run = await runKaneObjective(options(env));

    // #then both logs equal the fixture files exactly
    const [stdout, stderr, expectedStdout, expectedStderr] = await Promise.all([
      readFile(run.stdoutPath),
      readFile(run.stderrPath),
      readFile(fixturePath('pf02-2-fail', 'ndjson')),
      readFile(fixturePath('pf02-2-fail', 'stderr')),
    ]);
    expect([stdout.equals(expectedStdout), stderr.equals(expectedStderr), run.result.outcome]).toEqual([
      true,
      true,
      'failed',
    ]);
  });

  it('passes the documented argv to kane-cli', async () => {
    // #given the fake recording its invocation
    const invocation = join(workDir, 'invocation.json');
    const env = { ...replay('pf02-1-pass', 0), FAKE_KANE_INVOCATION: invocation };

    // #when a 1.5 s headless objective runs
    await runKaneObjective(options(env, { timeoutMs: 1_500 }));

    // #then the timeout is rounded up to whole seconds and --headless is appended
    const { argv } = JSON.parse(await readFile(invocation, 'utf8')) as { argv: string[] };
    expect(argv).toEqual([
      'run',
      'Open the source workspace and verify it shows 3 records',
      '--agent',
      '--url',
      'http://127.0.0.1:4100/w/source',
      '--timeout',
      '2',
      '--headless',
    ]);
  });

  it('gives kane-cli a minimal environment tagged with the ReturnTrip user agent', async () => {
    // #given a secret in our own environment that kane-cli must not see
    process.env.RETURNTRIP_TEST_SECRET = 'do-not-leak';
    const invocation = join(workDir, 'invocation.json');
    const env = { ...replay('pf02-1-pass', 0), FAKE_KANE_INVOCATION: invocation };

    // #when the objective runs
    try {
      await runKaneObjective(options(env));
    } finally {
      delete process.env.RETURNTRIP_TEST_SECRET;
    }

    // #then only allowlisted, caller-supplied and user-agent variables reach the child
    const { env: childEnv } = JSON.parse(await readFile(invocation, 'utf8')) as {
      env: Record<string, string>;
    };
    const allowed = new Set([
      'PATH',
      'HOME',
      'USER',
      'LANG',
      'TMPDIR',
      'KANE_CLI_USER_AGENT',
      ...Object.keys(env),
    ]);
    const unexpected = Object.keys(childEnv).filter(
      (key) => !allowed.has(key) && key !== '__CF_USER_TEXT_ENCODING',
    );
    expect([childEnv.KANE_CLI_USER_AGENT, childEnv.RETURNTRIP_TEST_SECRET, unexpected]).toEqual([
      'returntrip',
      undefined,
      [],
    ]);
  });

  it('reports every progress line to onProgress as it arrives', async () => {
    // #given a listener collecting progress
    const seen: KaneProgress[] = [];

    // #when pf02-2 is replayed
    await runKaneObjective(
      options(replay('pf02-2-fail', 1), { onProgress: (progress) => seen.push(progress) }),
    );

    // #then running and completed lines are both delivered, in order
    expect(seen.map((progress) => `${progress.step}:${progress.status}`)).toEqual([
      '2:running',
      '2:done',
      '3:running',
      '3:done',
      '4:running',
      '4:failed',
    ]);
  });

  it('records a throwing onProgress callback as a warning instead of failing the run', async () => {
    // #given a listener that throws
    const onProgress = (): void => {
      throw new Error('listener bug');
    };

    // #when pf02-1 is replayed
    const { result } = await runKaneObjective(options(replay('pf02-1-pass', 0), { onProgress }));

    // #then the outcome stands and the problem is visible
    expect([result.outcome, result.protocolWarnings[0]]).toEqual([
      'passed',
      'onProgress threw: listener bug',
    ]);
  });

  it('cancels on abort and kills the whole process group, grandchildren included', async () => {
    // #given a fake that starts a grandchild, replays slowly and then hangs
    const pidFile = join(workDir, 'grandchild.pid');
    const env = {
      ...replay('pf02-1-pass', 0),
      FAKE_KANE_LINE_DELAY_MS: '20',
      FAKE_KANE_HANG: '1',
      FAKE_KANE_GRANDCHILD_PID: pidFile,
    };
    const controller = new AbortController();

    // #when the run is aborted after the first progress line
    const { result } = await runKaneObjective(
      options(env, { signal: controller.signal, onProgress: () => controller.abort() }),
    );

    // #then the run is canceled and the grandchild is gone too
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    expect([result.outcome, await waitUntilDead(grandchild, 3_000)]).toEqual(['canceled', true]);
  });

  it('escalates to SIGKILL when kane-cli ignores SIGTERM', async () => {
    // #given a fake that ignores SIGTERM and never exits after replaying
    const env = { ...replay('pf02-1-pass', 0), FAKE_KANE_IGNORE_SIGTERM: '1', FAKE_KANE_HANG: '1' };
    const controller = new AbortController();
    const started = Date.now();

    // #when it is aborted on its first progress line with a 200 ms kill grace
    const { result } = await runKaneObjective(
      options(env, { signal: controller.signal, onProgress: () => controller.abort(), killGraceMs: 200 }),
    );

    // #then it is killed shortly after the grace period
    expect([result.outcome, result.signal, Date.now() - started < 5_000]).toEqual([
      'canceled',
      'SIGKILL',
      true,
    ]);
  });

  it('reports infra_error when kane-cli overruns its own deadline', async () => {
    // #given a fake that hangs past a 300 ms deadline with no extra grace
    const env = { FAKE_KANE_HANG: '1' };

    // #when the objective runs
    const { result } = await runKaneObjective(
      options(env, { timeoutMs: 300, hardTimeoutGraceMs: 0, killGraceMs: 100 }),
    );

    // #then the adapter's watchdog is named as the cause
    expect([result.outcome, result.protocolWarnings]).toEqual([
      'infra_error',
      ['kane-cli overran its deadline and was killed'],
    ]);
  });

  it('reports infra_error for exit 2 with no output', async () => {
    // #given a fake that exits 2 without writing anything, like a refused login
    const env = { FAKE_KANE_EXIT: '2' };

    // #when the objective runs
    const { result, events } = await runKaneObjective(options(env));

    // #then nothing is invented
    expect([result.outcome, result.exitCode, events]).toEqual(['infra_error', 2, []]);
  });

  it('reports infra_error when the kane-cli binary does not exist', async () => {
    // #given a binary path that is not there
    const kaneBin = join(workDir, 'missing-kane-cli');

    // #when the objective runs
    const { result } = await runKaneObjective(options({}, { kaneBin }));

    // #then the spawn failure is recorded instead of thrown
    expect([result.outcome, result.protocolWarnings[0]?.startsWith('could not start kane-cli:')]).toEqual([
      'infra_error',
      true,
    ]);
  });

  it('does not start kane-cli when the signal is already aborted', async () => {
    // #given an aborted signal and a fake that would record its invocation
    const invocation = join(workDir, 'invocation.json');
    const signal = AbortSignal.abort();

    // #when the objective runs
    const run = await runKaneObjective(options({ FAKE_KANE_INVOCATION: invocation }, { signal }));

    // #then it is canceled, the fake never ran, and empty logs still exist
    const invoked = await readFile(invocation).then(
      () => true,
      () => false,
    );
    expect([run.result.outcome, invoked, await readFile(run.stdoutPath, 'utf8')]).toEqual([
      'canceled',
      false,
      '',
    ]);
  });

  it('rejects an objective that kane-cli would parse as a flag', async () => {
    // #given an objective starting with a dash
    const bad = options({}, { objective: '--help' });

    // #when the objective runs
    const run = runKaneObjective(bad);

    // #then it is refused before anything is spawned
    await expect(run).rejects.toThrow('objective must not start with "-"');
  });

  it('rejects a non-http start URL', async () => {
    // #given a file URL
    const bad = options({}, { url: 'file:///etc/passwd' });

    // #when the objective runs
    const run = runKaneObjective(bad);

    // #then it is refused
    await expect(run).rejects.toThrow(TypeError);
  });
});
