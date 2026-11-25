import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { type LoadedConfig, loadConfig } from '@returntrip/orchestrator';
import { RunStore } from '@returntrip/storage';

export const DEFAULT_CONFIG = 'returntrip.yaml';

export interface GlobalOptions {
  readonly config?: string;
  readonly store?: string;
}

/** Runs live next to the project they belong to, under .returntrip/ (gitignored). */
export function storeRootFor(loaded: LoadedConfig | null, explicit?: string): string {
  if (explicit) return explicit;
  return join(loaded?.projectRoot ?? process.cwd(), '.returntrip');
}

export async function openStore(loaded: LoadedConfig | null, explicit?: string): Promise<RunStore> {
  return RunStore.open(storeRootFor(loaded, explicit));
}

export async function loadOptionalConfig(path: string | undefined): Promise<LoadedConfig | null> {
  try {
    return await loadConfig(path ?? DEFAULT_CONFIG);
  } catch {
    return null;
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Asks a yes/no question on the terminal. Never called without a TTY. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
