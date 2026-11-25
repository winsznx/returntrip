import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeFileName(name: string): void {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new Error(`unsafe artifact file name: ${JSON.stringify(name)}`);
  }
}

/** Resolves `child` under `root` and refuses anything that escapes it. */
export function containedPath(root: string, child: string): string {
  const absolute = resolve(root, child);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`path escapes artifact root: ${child}`);
  }
  return absolute;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  await pipeline(createReadStream(path), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      hash.update(chunk);
      byteLength += chunk.length;
    }
  });
  return { sha256: hash.digest('hex'), byteLength };
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/** temp file → fsync → rename, so a crash never leaves a half-written artifact under its final name. */
export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function copyFileAtomic(source: string, destination: string): Promise<void> {
  await writeFileAtomic(destination, await readFile(source));
  await chmod(destination, 0o600);
}
