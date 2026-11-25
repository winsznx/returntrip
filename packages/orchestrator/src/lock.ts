import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid in a lock file, or null when the file is unreadable (treated as stale). */
function parseHolder(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** One active run per project. A lock left by a dead process is taken over, never a live one. */
export async function acquireProjectLock(root: string, project: string): Promise<() => Promise<void>> {
  const dir = join(root, 'locks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${project}.lock`);
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      // Write the pid first, then link the file into place: the lock appears atomically and is
      // never seen empty.
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
        mode: 0o600,
      });
      try {
        await link(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const text = await readFile(path, 'utf8').catch(() => '');
      const holder = parseHolder(text);
      if (holder !== null && alive(holder)) {
        throw new Error(`project ${project} already has an active run (pid ${holder})`);
      }
      // Take over only the exact stale file we read, so two processes can't both clear it.
      const current = await readFile(path, 'utf8').catch(() => null);
      if (current !== text) continue;
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not lock project ${project}`);
}
