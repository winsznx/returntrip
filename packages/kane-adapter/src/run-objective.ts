import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { BrowserResult } from '@returntrip/contracts';

import { kaneEnvironment, signalProcessGroup } from './child-process.ts';
import { asProgressEvent } from './kane-events.ts';
import { NdjsonParser } from './ndjson-parser.ts';
import { type KaneInterruption, normalizeKaneRun } from './normalize-run.ts';

const DEFAULT_KANE_BIN = 'kane-cli';
const DEFAULT_HARD_TIMEOUT_GRACE_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
/** How long stdio may stay open after the leader exits before leftovers are killed. */
const STDIO_DRAIN_MS = 2_000;
const STDERR_TAIL_CHARS = 256 * 1024;

export interface KaneProgress {
  readonly step: number;
  readonly status: string;
  readonly remark: string;
}

export interface KaneRunOptions {
  readonly objective: string;
  readonly url: string;
  readonly timeoutMs: number;
  readonly headless: boolean;
  readonly cwd: string;
  readonly logDir: string;
  readonly kaneBin?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: KaneProgress) => void;
  /**
   * Kane gets `--timeout` and should stop itself. Past `timeoutMs` plus this grace, ReturnTrip
   * kills the process group and reports infra_error. Kane's post-run upload can take minutes.
   */
  readonly hardTimeoutGraceMs?: number;
  /** Delay between SIGTERM and SIGKILL, so Kane can close the browser it launched. */
  readonly killGraceMs?: number;
}

export interface KaneRunResult {
  readonly result: BrowserResult;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly events: unknown[];
}

interface ProcessEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly interruption: KaneInterruption | null;
}

type KaneChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Runs one kane-cli objective in agent mode and normalizes the outcome. Never throws for
 * anything Kane does: spawn failures, crashes and timeouts resolve as non-passing results.
 * Rejects only for invalid options or when the log directory cannot be written.
 */
export async function runKaneObjective(options: KaneRunOptions): Promise<KaneRunResult> {
  validateOptions(options);
  await mkdir(options.logDir, { recursive: true });
  const stdoutPath = join(options.logDir, 'kane.stdout.ndjson');
  const stderrPath = join(options.logDir, 'kane.stderr.log');
  const stdoutLog = createWriteStream(stdoutPath);
  const stderrLog = createWriteStream(stderrPath);
  const warnings: string[] = [];
  for (const [name, log] of [
    ['stdout', stdoutLog],
    ['stderr', stderrLog],
  ] as const) {
    log.on('error', (error) => warnings.push(`could not write ${name} log: ${error.message}`));
  }

  const parser = new NdjsonParser();
  const events: unknown[] = [];
  const stderrDecoder = new StringDecoder('utf8');
  let stderrTail = '';
  const startedAt = new Date().toISOString();

  const acceptEvents = (parsed: readonly unknown[]): void => {
    for (const event of parsed) {
      events.push(event);
      const progress = asProgressEvent(event);
      if (!progress || !options.onProgress) continue;
      try {
        options.onProgress({ step: progress.step, status: progress.status, remark: progress.remark });
      } catch (error) {
        warnings.push(`onProgress threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  let end: ProcessEnd;
  if (options.signal?.aborted) {
    end = { exitCode: null, signal: null, interruption: 'aborted' };
  } else {
    const child = spawn(options.kaneBin ?? DEFAULT_KANE_BIN, kaneArgs(options), {
      cwd: options.cwd,
      env: kaneEnvironment(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so cancellation reaches the browser and helpers Kane starts.
      detached: true,
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLog.write(chunk);
      acceptEvents(parser.push(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLog.write(chunk);
      stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    end = await superviseChild(child, options, warnings);
  }

  acceptEvents(parser.end());
  stderrTail = (stderrTail + stderrDecoder.end()).slice(-STDERR_TAIL_CHARS);
  await Promise.all([closeLog(stdoutLog), closeLog(stderrLog)]);

  const result = normalizeKaneRun({
    events,
    exitCode: end.exitCode,
    signal: end.signal,
    stderr: stderrTail,
    startedAt,
    finishedAt: new Date().toISOString(),
    interruption: end.interruption,
    protocolWarnings: [...parser.warnings, ...warnings],
  });
  return { result, stdoutPath, stderrPath, events };
}

export function kaneArgs(
  options: Pick<KaneRunOptions, 'objective' | 'url' | 'timeoutMs' | 'headless'>,
): string[] {
  const args = [
    'run',
    options.objective,
    '--agent',
    '--url',
    options.url,
    '--timeout',
    String(Math.ceil(options.timeoutMs / 1000)),
  ];
  if (options.headless) args.push('--headless');
  return args;
}

function validateOptions(options: KaneRunOptions): void {
  if (options.objective.trim() === '') throw new TypeError('objective must not be empty');
  // A leading dash would be parsed by kane-cli as a flag rather than as the objective.
  if (options.objective.startsWith('-')) throw new TypeError('objective must not start with "-"');
  const url = URL.parse(options.url);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new TypeError(`url must be an absolute http(s) URL, got ${JSON.stringify(options.url)}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number, got ${options.timeoutMs}`);
  }
  for (const [name, value] of [
    ['hardTimeoutGraceMs', options.hardTimeoutGraceMs],
    ['killGraceMs', options.killGraceMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative number, got ${value}`);
    }
  }
}

function superviseChild(child: KaneChild, options: KaneRunOptions, warnings: string[]): Promise<ProcessEnd> {
  return new Promise((resolve) => {
    let interruption: KaneInterruption | null = null;
    let exited = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      const outcome = signalProcessGroup(child.pid, signal);
      if (outcome instanceof Error) warnings.push(`could not send ${signal} to kane-cli: ${outcome.message}`);
    };

    const terminate = (reason: KaneInterruption): void => {
      if (interruption !== null || exited) return;
      interruption = reason;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => signalGroup('SIGKILL'), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
    };

    const onAbort = (): void => terminate('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(
      setTimeout(
        () => terminate('timed_out'),
        options.timeoutMs + (options.hardTimeoutGraceMs ?? DEFAULT_HARD_TIMEOUT_GRACE_MS),
      ),
    );

    const finish = (end: ProcessEnd): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(end);
    };

    child.once('error', (error) => {
      if (child.pid !== undefined) {
        warnings.push(`kane-cli process error: ${error.message}`);
        return;
      }
      warnings.push(`could not start kane-cli: ${error.message}`);
      finish({ exitCode: null, signal: null, interruption });
    });

    child.once('exit', () => {
      exited = true;
      // Descendants that outlive the leader are orphans of a finished run: reap them, and
      // stop waiting on any stdio pipe they still hold open.
      timers.push(
        setTimeout(() => {
          signalGroup('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
        }, STDIO_DRAIN_MS),
      );
      if (interruption !== null) signalGroup('SIGKILL');
    });

    child.once('close', (exitCode, signal) => {
      finish({ exitCode, signal, interruption });
    });
  });
}

function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (log.closed) {
      resolve();
      return;
    }
    log.end(() => resolve());
    log.once('error', () => resolve());
  });
}
