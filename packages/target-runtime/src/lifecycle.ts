import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { fillArgv, type PlaceholderValues } from './placeholders.ts';
import { type ExecResult, execArgv, killTree, minimalEnv } from './process.ts';

export async function allocatePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port');
  return address.port;
}

export async function waitForHealth(options: {
  readonly url: string;
  readonly timeoutMs: number;
  readonly isAlive?: () => boolean;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const started = performance.now();
  let lastError = 'no response';
  while (performance.now() - started < options.timeoutMs) {
    options.signal?.throwIfAborted();
    if (options.isAlive && !options.isAlive()) throw new Error('target exited before it became healthy');
    try {
      const response = await fetch(options.url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
      if (response.ok) return performance.now() - started;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `target did not become healthy at ${options.url} within ${options.timeoutMs} ms (${lastError})`,
  );
}

export interface RunningTarget {
  readonly origin: string;
  readonly port: number;
  readonly pid: number;
  readonly startupMs: number;
  stop(): Promise<void>;
  isAlive(): boolean;
}

/** Starts a managed target as its own process group and waits for its health endpoint. */
export async function startTarget(options: {
  readonly dir: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly values: PlaceholderValues;
  readonly port: number;
  readonly healthPath: string;
  readonly startupTimeoutMs: number;
  readonly logPath: string;
  readonly signal?: AbortSignal;
}): Promise<RunningTarget> {
  const [command, ...args] = fillArgv(options.argv, options.values);
  if (!command) throw new Error('empty start command');
  const env = minimalEnv(
    Object.fromEntries(
      Object.entries(options.env).map(([key, value]) => [key, fillArgv([value], options.values)[0] ?? '']),
    ),
  );
  const log = createWriteStream(options.logPath, { flags: 'a', mode: 0o600 });
  const child: ChildProcess = spawn(command, args, {
    cwd: options.dir,
    env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const spawnError = new Promise<never>((_, reject) => {
    child.once('error', reject);
  });
  const isAlive = (): boolean => child.exitCode === null && child.signalCode === null;
  const stop = async (): Promise<void> => {
    await killTree(child);
    await new Promise<void>((resolve) => log.end(resolve));
  };

  const origin = `http://127.0.0.1:${options.port}`;
  try {
    const startupMs = await Promise.race([
      waitForHealth({
        url: `${origin}${options.healthPath}`,
        timeoutMs: options.startupTimeoutMs,
        isAlive,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      spawnError,
    ]);
    if (child.pid === undefined) throw new Error('target process has no pid');
    return { origin, port: options.port, pid: child.pid, startupMs, stop, isAlive };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Runs a configured one-shot step (build, seed) and fails loudly on a non-zero exit. */
export async function runStep(options: {
  readonly name: string;
  readonly dir: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly values: PlaceholderValues;
  readonly timeoutMs: number;
  readonly logPath: string;
  readonly signal?: AbortSignal;
}): Promise<ExecResult> {
  const result = await execArgv(fillArgv(options.argv, options.values), {
    cwd: options.dir,
    env: minimalEnv(
      Object.fromEntries(
        Object.entries(options.env).map(([key, value]) => [key, fillArgv([value], options.values)[0] ?? '']),
      ),
    ),
    timeoutMs: options.timeoutMs,
    logPath: options.logPath,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.timedOut) throw new Error(`${options.name} timed out after ${options.timeoutMs} ms`);
  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
    throw new Error(`${options.name} exited with code ${result.exitCode}: ${tail}`);
  }
  return result;
}
