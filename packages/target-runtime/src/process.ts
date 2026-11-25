import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';

export interface ExecResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly logPath?: string;
  readonly maxCaptureBytes?: number;
  readonly signal?: AbortSignal;
}

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL'] as const;

/** Explicit allowlist: the child never inherits our credentials or unrelated environment. */
export function minimalEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Kills the whole process group so grandchildren (servers, browsers) don't outlive the run. */
export async function killTree(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  const send = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const exited = once(child, 'exit');
  send('SIGTERM');
  const timer = setTimeout(() => send('SIGKILL'), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

function capture(limit: number): { push: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= limit) return;
      const slice = chunk.subarray(0, limit - size);
      chunks.push(slice);
      size += slice.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Runs argv without a shell, bounded in time and captured output. */
export async function execArgv(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const [command, ...args] = argv;
  if (!command) throw new Error('empty argv');
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const limit = options.maxCaptureBytes ?? 1024 * 1024;
  const stdout = capture(limit);
  const stderr = capture(limit);
  let log: WriteStream | undefined;
  if (options.logPath) log = createWriteStream(options.logPath, { flags: 'a', mode: 0o600 });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    log?.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
    log?.write(chunk);
  });
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, options.timeoutMs);
  const onAbort = (): void => {
    void killTree(child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  // An already-aborted signal never fires 'abort', so check it once the child exists.
  if (options.signal?.aborted) onAbort();

  try {
    const [exitCode, signal] = (await Promise.race([
      once(child, 'close'),
      once(child, 'error').then(([error]) => {
        throw error;
      }),
    ])) as [number | null, NodeJS.Signals | null];
    return {
      exitCode,
      signal,
      durationMs: performance.now() - started,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (log) await new Promise<void>((resolve) => log.end(resolve));
  }
}
