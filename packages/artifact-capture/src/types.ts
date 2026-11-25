import type { PendingCapture } from './expectation.ts';

export interface CapturedArtifact {
  readonly stage: string;
  readonly workspace: string;
  /** Final location, `<artifactDir>/<stage>-<sha256 first 12>.csv`. */
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly status: number;
  readonly contentType: string | null;
  /** Content-Disposition with control characters removed, as metadata only. */
  readonly contentDisposition: string | null;
  readonly method: string;
  /** Request path without its query string. */
  readonly routePath: string;
  readonly requestStartedAt: string;
  readonly capturedAt: string;
}

export interface RestoreObservation {
  readonly stage: string;
  readonly workspace: string;
  /** sha256 of the uploaded file part, or of the whole body when `wholeBody` is true. */
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string | null;
  readonly contentType: string | null;
  readonly wholeBody: boolean;
  readonly method: string;
  readonly routePath: string;
  readonly responseStatus: number;
  readonly observedAt: string;
}

export interface RequestLogEntry {
  readonly at: string;
  readonly method: string;
  /** Request path without its query string. Headers, cookies and bodies are never logged. */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly bytesOut: number;
  readonly matched: 'export' | 'restore' | null;
  /** A response shaped like the export that arrived outside any matching expectation. */
  readonly unexpected?: boolean;
}

export type CaptureExpectation = PendingCapture<CapturedArtifact>;
export type RestoreExpectation = PendingCapture<RestoreObservation>;

export interface ExpectationTarget {
  readonly stage: string;
  readonly workspace: string;
}

export interface CaptureProxy {
  /** Origin the browser should use instead of the upstream, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  expectExport(target: ExpectationTarget): CaptureExpectation;
  expectRestore(target: ExpectationTarget): RestoreExpectation;
  requestLog(): readonly RequestLogEntry[];
  /** Stops listening, cancels open expectations and drops every connection. */
  close(): Promise<void>;
}
