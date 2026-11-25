import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface TeeResult {
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Copies a response body into a private temp file while it streams to the browser, hashing
 * bytes in arrival order. Writes are serialized; a write failure is remembered and reported
 * by `finalize` rather than interrupting the browser's transfer.
 */
export class FileTee {
  readonly #tempPath: string;
  readonly #handle: Promise<FileHandle>;
  readonly #hash = createHash('sha256');
  #chain: Promise<void>;
  #byteLength = 0;
  #failure: Error | null = null;
  #done = false;

  constructor(directory: string, label: string) {
    this.#tempPath = join(directory, `.${label}-${randomUUID()}.partial`);
    this.#handle = open(this.#tempPath, 'wx', 0o600);
    this.#chain = this.#handle.then(
      () => undefined,
      (error: unknown) => this.#remember(error),
    );
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  /** Resolves once the chunk is on its way to disk. Never rejects. */
  write(chunk: Buffer): Promise<void> {
    if (this.#done) return Promise.resolve();
    this.#hash.update(chunk);
    this.#byteLength += chunk.length;
    this.#chain = this.#chain.then(async () => {
      if (this.#failure) return;
      try {
        const handle = await this.#handle;
        await handle.write(chunk);
      } catch (error) {
        this.#remember(error);
      }
    });
    return this.#chain;
  }

  /** Flushes, fsyncs and atomically renames the file into place. */
  async finalize(pathFor: (sha256: string) => string): Promise<TeeResult & { readonly path: string }> {
    this.#done = true;
    await this.#chain;
    if (this.#failure) {
      await this.#cleanup();
      throw this.#failure;
    }
    const sha256 = this.#hash.digest('hex');
    const path = pathFor(sha256);
    try {
      const handle = await this.#handle;
      await handle.sync();
      await handle.close();
      await rename(this.#tempPath, path);
    } catch (error) {
      await this.#cleanup();
      throw error;
    }
    return { path, sha256, byteLength: this.#byteLength };
  }

  /** Stops recording and removes the temp file. Never rejects. */
  async discard(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#chain;
    await this.#cleanup();
  }

  async #cleanup(): Promise<void> {
    try {
      const handle = await this.#handle;
      await handle.close();
    } catch (error) {
      this.#remember(error);
    }
    await rm(this.#tempPath, { force: true }).catch((error: unknown) => this.#remember(error));
  }

  #remember(error: unknown): void {
    this.#failure ??= error instanceof Error ? error : new Error(String(error));
  }
}
