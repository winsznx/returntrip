import { runCommand } from './child-process.ts';

const DEFAULT_KANE_BIN = 'kane-cli';
const INFO_TIMEOUT_MS = 30_000;
const VERSION_PATTERN = /(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const BALANCE_PATTERN = /^Available credits:\s*(\d+(?:\.\d+)?)\s*$/m;
const SKILL_UPDATE_LINE = /^.*skill update available.*$/gim;

/** Reads `kane-cli --version`. Resolves null when the output carries no version number. */
export async function getKaneVersion(kaneBin: string = DEFAULT_KANE_BIN): Promise<string | null> {
  const output = await runCommand(kaneBin, ['--version'], { timeoutMs: INFO_TIMEOUT_MS });
  return parseKaneVersion(output.stdout) ?? parseKaneVersion(output.stderr);
}

/**
 * Reads the credit balance from `kane-cli balance`. Resolves null when no balance line is
 * present, for example when the CLI is logged out. This command does not spend credits.
 */
export async function getKaneBalance(kaneBin: string = DEFAULT_KANE_BIN): Promise<number | null> {
  const output = await runCommand(kaneBin, ['balance'], { timeoutMs: INFO_TIMEOUT_MS });
  return parseKaneBalance(output.stdout) ?? parseKaneBalance(output.stderr);
}

export function parseKaneVersion(output: string): string | null {
  return VERSION_PATTERN.exec(output)?.[1] ?? null;
}

export function parseKaneBalance(output: string): number | null {
  const cleaned = output.replace(SKILL_UPDATE_LINE, '');
  const match = BALANCE_PATTERN.exec(cleaned);
  if (!match?.[1]) return null;
  const balance = Number(match[1]);
  return Number.isFinite(balance) ? balance : null;
}
