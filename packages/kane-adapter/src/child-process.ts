import { spawn } from 'node:child_process';

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const;

/**
 * Environment handed to kane-cli: a short allowlist from our own process, caller overrides,
 * then the user agent tag. Credentials in our environment never leak into the child.
 */
export function kaneEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, extra);
  env.KANE_CLI_USER_AGENT = 'returntrip';
  return env;
}

/**
 * Signals every process in the group led by `pid`. Returns false once the group is gone.
 * Other failures (EPERM) are returned as an Error so callers can report them.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean | Error {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return false;
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Runs a short, non-interactive command with argv only. Rejects on spawn failure or timeout. */
export function runCommand(
  bin: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: kaneEnvironment(),
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (signal === 'SIGKILL' && exitCode === null) {
        reject(new Error(`${bin} ${args.join(' ')} timed out after ${options.timeoutMs} ms`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
      });
    });
  });
}
