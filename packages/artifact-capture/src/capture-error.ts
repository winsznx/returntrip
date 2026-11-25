export type CaptureErrorCode =
  /** `wait` ran out of time before a complete matching transfer. */
  | 'TIMEOUT'
  /** The transfer was cut short by either side, or ended shorter than its Content-Length. */
  | 'INCOMPLETE'
  /** More than one matching transfer happened inside one expectation window. */
  | 'AMBIGUOUS'
  /** The body exceeded `capture.maxBytes`. The browser still received it. */
  | 'TOO_LARGE'
  /** The upstream sent a Content-Encoding, so wire bytes are not the file bytes. */
  | 'ENCODED'
  /** A multipart upload could not be parsed. */
  | 'MALFORMED'
  /** A multipart upload had no file in the configured field. */
  | 'NO_FILE'
  /** The upstream could not be reached or failed before responding. */
  | 'UPSTREAM'
  /** Writing the artifact to disk failed. */
  | 'IO'
  /** The caller canceled the expectation or closed the proxy. */
  | 'CANCELED';

export class CaptureError extends Error {
  override readonly name = 'CaptureError';
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
