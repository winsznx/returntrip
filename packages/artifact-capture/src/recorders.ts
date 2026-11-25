import { join } from 'node:path';

import { CaptureError } from './capture-error.ts';
import type { Expectation } from './expectation.ts';
import { FileTee } from './file-tee.ts';
import { inspectRestoreBody } from './restore-body.ts';
import type { CapturedArtifact, RestoreObservation } from './types.ts';

export interface ExportResponseMeta {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentDisposition: string | null;
  readonly method: string;
  readonly routePath: string;
  readonly requestStartedAt: string;
  /** Declared Content-Length, used to detect a body that ended early. */
  readonly contentLength: number | null;
}

/** Records one export response body, bounded by maxBytes, into the artifact directory. */
export class ExportRecorder {
  readonly #expectation: Expectation<CapturedArtifact>;
  readonly #tee: FileTee;
  readonly #artifactDir: string;
  readonly #maxBytes: number;
  readonly #meta: ExportResponseMeta;
  #active = true;
  /** Set by the proxy right after the expectation accepted this transfer. */
  release: (() => void) | undefined;

  #succeed(value: CapturedArtifact): void {
    this.#expectation.succeed(value, this.release);
  }

  #failWith(error: CaptureError): void {
    this.#expectation.fail(error, this.release);
  }

  constructor(
    expectation: Expectation<CapturedArtifact>,
    artifactDir: string,
    maxBytes: number,
    meta: ExportResponseMeta,
  ) {
    this.#expectation = expectation;
    this.#artifactDir = artifactDir;
    this.#maxBytes = maxBytes;
    this.#meta = meta;
    this.#tee = new FileTee(artifactDir, expectation.stage);
  }

  /** Called for every body chunk on its way to the browser. Never rejects. */
  accept(chunk: Buffer): Promise<void> | null {
    if (!this.#active) return null;
    if (this.#tee.byteLength + chunk.length > this.#maxBytes) {
      this.#stop();
      this.#failWith(
        new CaptureError(
          'TOO_LARGE',
          `export for stage ${this.#expectation.stage} exceeds ${this.#maxBytes} bytes`,
        ),
      );
      return null;
    }
    return this.#tee.write(chunk);
  }

  /** Stops recording without settling the expectation; the expectation is settling itself. */
  abort(): void {
    this.#stop();
  }

  /** Settles the expectation once the browser has the whole body, or knows it never will. */
  finish(transferError: Error | null, upstreamComplete: boolean): void {
    if (!this.#active) return;
    const received = this.#tee.byteLength;
    const declared = this.#meta.contentLength;
    if (transferError || !upstreamComplete || (declared !== null && declared !== received)) {
      this.#stop();
      const why = transferError?.message ?? `received ${received} of ${declared ?? 'unknown'} bytes`;
      this.#failWith(
        new CaptureError(
          'INCOMPLETE',
          `export for stage ${this.#expectation.stage} did not complete: ${why}`,
          {
            cause: transferError ?? undefined,
          },
        ),
      );
      return;
    }
    this.#active = false;
    const { stage, workspace } = this.#expectation;
    this.#tee
      .finalize((sha256) => join(this.#artifactDir, `${stage}-${sha256.slice(0, 12)}.csv`))
      .then(
        (file) => {
          const { contentLength: _declared, ...meta } = this.#meta;
          this.#succeed({
            stage,
            workspace,
            ...file,
            ...meta,
            capturedAt: new Date().toISOString(),
          });
        },
        (error: unknown) => {
          this.#failWith(
            new CaptureError('IO', `could not store export for stage ${stage}`, { cause: error }),
          );
        },
      );
  }

  #stop(): void {
    if (!this.#active) return;
    this.#active = false;
    void this.#tee.discard();
  }
}

export interface RestoreRequestMeta {
  readonly method: string;
  readonly routePath: string;
  readonly contentType: string | undefined;
}

/**
 * Buffers one restore upload, bounded by maxBytes, while it streams upstream unchanged, then
 * hashes the uploaded file once both the body and the upstream status are known.
 */
export class RestoreRecorder {
  readonly #expectation: Expectation<RestoreObservation>;
  readonly #maxBytes: number;
  readonly #fileField: string;
  readonly #meta: RestoreRequestMeta;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #active = true;
  #bodyComplete = false;
  #responseStatus: number | null = null;
  /** Set by the proxy right after the expectation accepted this transfer. */
  release: (() => void) | undefined;

  #succeed(value: RestoreObservation): void {
    this.#expectation.succeed(value, this.release);
  }

  #failWith(error: CaptureError): void {
    this.#expectation.fail(error, this.release);
  }

  constructor(
    expectation: Expectation<RestoreObservation>,
    maxBytes: number,
    fileField: string,
    meta: RestoreRequestMeta,
  ) {
    this.#expectation = expectation;
    this.#maxBytes = maxBytes;
    this.#fileField = fileField;
    this.#meta = meta;
  }

  accept(chunk: Buffer): void {
    if (!this.#active) return;
    this.#bytes += chunk.length;
    if (this.#bytes > this.#maxBytes) {
      this.#fail(
        new CaptureError(
          'TOO_LARGE',
          `restore upload for stage ${this.#expectation.stage} exceeds ${this.#maxBytes} bytes`,
        ),
      );
      return;
    }
    this.#chunks.push(chunk);
  }

  abort(): void {
    this.#active = false;
    this.#chunks = [];
  }

  bodyFinished(error: Error | null): void {
    if (error) {
      this.#fail(
        new CaptureError('INCOMPLETE', `restore upload did not complete: ${error.message}`, { cause: error }),
      );
      return;
    }
    this.#bodyComplete = true;
    this.#settleIfReady();
  }

  responded(status: number): void {
    this.#responseStatus = status;
    this.#settleIfReady();
  }

  upstreamFailed(error: Error): void {
    this.#fail(
      new CaptureError('UPSTREAM', `restore upload was not delivered: ${error.message}`, { cause: error }),
    );
  }

  #settleIfReady(): void {
    const status = this.#responseStatus;
    if (!this.#active || !this.#bodyComplete || status === null) return;
    this.#active = false;
    const body = Buffer.concat(this.#chunks, this.#bytes);
    this.#chunks = [];
    const { stage, workspace } = this.#expectation;
    inspectRestoreBody(body, this.#meta.contentType, this.#fileField).then(
      (payload) => {
        this.#succeed({
          stage,
          workspace,
          ...payload,
          method: this.#meta.method,
          routePath: this.#meta.routePath,
          responseStatus: status,
          observedAt: new Date().toISOString(),
        });
      },
      (error: unknown) => {
        this.#failWith(
          error instanceof CaptureError
            ? error
            : new CaptureError('MALFORMED', 'restore upload could not be read', { cause: error }),
        );
      },
    );
  }

  #fail(error: CaptureError): void {
    if (!this.#active) return;
    this.abort();
    this.#failWith(error);
  }
}
