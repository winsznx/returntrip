import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One active run per project. A lock left by a dead process is taken over, never a live one. */
export async function acquireProjectLock(root: string, project: string): Promise<() => Promise<void>> {
  const dir = join(root, 'locks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${project}.lock`);
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as { pid?: number };
      if (typeof holder.pid === 'number' && alive(holder.pid)) {
        throw new Error(`project ${project} already has an active run (pid ${holder.pid})`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not lock project ${project}`);
}
