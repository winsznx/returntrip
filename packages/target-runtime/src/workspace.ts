import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { sha256 } from './hash.ts';
import { execArgv, minimalEnv } from './process.ts';

const COPY_EXCLUDES = new Set(['node_modules', '.git', 'dist', '.returntrip', 'coverage']);
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
/** Never let anything inside the copy configure git: no fsmonitor command, no hooks. */
const GIT_HARDENING = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.untrackedCache=false',
];
/** Snapshot every file, ignored or not, except dependency and build directories. */
const SNAPSHOT_PATHSPEC = ['--', '.', ...[...COPY_EXCLUDES].map((name) => `:(exclude,glob)**/${name}/**`)];

/** The copy's git metadata lives beside it, outside anything the repair agent can edit. */
export function gitDirFor(dir: string): string {
  return `${dir}.gitmeta`;
}

export interface TargetCopy {
  readonly dir: string;
  /** git tree id of the copy as it started (after any scenario patch). Repairs are diffed against it. */
  readonly baseTree: string;
  readonly scenarioPatchSha256: string | null;
}

/**
 * git over a disposable copy only, with user and system config ignored and the repository kept
 * outside the copy. Snapshots are tree objects, never commits, so no author identity is involved.
 */
export async function gitInCopy(dir: string, args: readonly string[], stdin?: string): Promise<string> {
  const result = await execArgv(
    ['git', `--git-dir=${gitDirFor(dir)}`, `--work-tree=${dir}`, ...GIT_HARDENING, ...args],
    {
      cwd: dir,
      env: minimalEnv(GIT_ENV),
      timeoutMs: 60_000,
      ...(stdin === undefined ? {} : { stdin }),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ''} failed in target copy: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Stages the whole copy, including files the app's own .gitignore would hide (an edited
 * .env.local must show up in a diff), but not dependency or build directories.
 */
async function stageAll(dir: string): Promise<void> {
  await gitInCopy(dir, ['add', '--all', '--force', ...SNAPSHOT_PATHSPEC]);
}

export async function snapshotTree(dir: string): Promise<string> {
  await stageAll(dir);
  return (await gitInCopy(dir, ['write-tree'])).trim();
}

/** Unified diff of the working copy against a snapshot, binary-aware, no rename detection. */
export async function diffAgainst(dir: string, baseTree: string): Promise<string> {
  await stageAll(dir);
  return gitInCopy(dir, [
    'diff',
    '--cached',
    '--binary',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    baseTree,
  ]);
}

/** Changed paths with their old and new modes, for symlink and permission checks. */
export async function rawChangesAgainst(
  dir: string,
  baseTree: string,
): Promise<{ path: string; oldMode: string; newMode: string; status: string }[]> {
  await stageAll(dir);
  const raw = await gitInCopy(dir, ['diff', '--cached', '--raw', '--no-renames', '-z', baseTree]);
  const parts = raw.split('\0').filter((part) => part.length > 0);
  const changes: { path: string; oldMode: string; newMode: string; status: string }[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index] ?? '';
    const path = parts[index + 1] ?? '';
    const [oldMode = '', newMode = '', , , status = ''] = meta.replace(/^:/, '').split(' ');
    changes.push({ path, oldMode, newMode, status });
  }
  return changes;
}

/** Lines added plus deleted, as git counts them, so diff text that looks like a header can't hide. */
export async function changedLinesAgainst(
  dir: string,
  baseTree: string,
): Promise<{ lines: number; binary: boolean }> {
  await stageAll(dir);
  const numstat = await gitInCopy(dir, ['diff', '--cached', '--numstat', '--no-renames', baseTree]);
  let lines = 0;
  let binary = false;
  for (const row of numstat.split('\n')) {
    const [added, deleted] = row.split('\t');
    if (added === undefined || deleted === undefined) continue;
    if (added === '-' || deleted === '-') binary = true;
    else lines += Number(added) + Number(deleted);
  }
  return { lines, binary };
}

/** Puts the working copy back to a snapshot, discarding every change made since. */
export async function restoreTree(dir: string, tree: string): Promise<void> {
  await gitInCopy(dir, ['read-tree', '--reset', '-u', tree]);
  await gitInCopy(dir, ['clean', '-fdqx', ...[...COPY_EXCLUDES].flatMap((name) => ['-e', name])]);
}

export async function applyPatch(dir: string, patch: string): Promise<void> {
  await gitInCopy(dir, ['apply', '--whitespace=nowarn', '-'], patch);
}

/**
 * Copies the application into a fresh directory and snapshots it, then optionally applies a
 * scenario patch. The user's working tree is never modified.
 */
export async function prepareTargetCopy(options: {
  readonly appDir: string;
  readonly parentDir: string;
  readonly label: string;
  readonly scenarioPatch?: string;
}): Promise<TargetCopy> {
  await mkdir(options.parentDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(options.parentDir, `${options.label}-`));
  await cp(options.appDir, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const rel = relative(options.appDir, source);
      return !rel.split(/[\\/]/).some((segment) => COPY_EXCLUDES.has(segment));
    },
  });
  await gitInCopy(dir, ['init', '--quiet']);

  let scenarioPatchSha256: string | null = null;
  if (options.scenarioPatch) {
    const patch = await readFile(options.scenarioPatch, 'utf8');
    scenarioPatchSha256 = sha256(patch);
    await applyPatch(dir, patch);
  }
  return { dir, baseTree: await snapshotTree(dir), scenarioPatchSha256 };
}

export async function removeTargetCopy(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await rm(gitDirFor(dir), { recursive: true, force: true });
}

/** sha256 of every regular file under the given relative paths, for before/after tamper checks. */
export async function hashTree(root: string, paths: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      hashes[relative(root, path)] = 'symlink';
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (!COPY_EXCLUDES.has(entry)) await walk(join(path, entry));
      }
      return;
    }
    if (stat.isFile()) hashes[relative(root, path)] = sha256(await readFile(path));
  };
  for (const path of paths) await walk(join(root, path));
  return hashes;
}
