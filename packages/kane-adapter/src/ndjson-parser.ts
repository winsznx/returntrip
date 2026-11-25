export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export interface NdjsonParserOptions {
  /** Longest accepted line in bytes, excluding the line terminator. */
  readonly maxLineBytes?: number;
}

/**
 * Incremental NDJSON decoder for a child process stream. Works on bytes so a UTF-8 sequence
 * split across chunks is reassembled before decoding, and so the line limit is a byte limit.
 * Bad lines never throw: they are dropped and recorded as protocol warnings.
 */
export class NdjsonParser {
  readonly #maxLineBytes: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #warnings: string[] = [];
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #discarding = false;
  #lineNumber = 0;

  constructor(options: NdjsonParserOptions = {}) {
    const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError(`maxLineBytes must be a positive integer, got ${maxLineBytes}`);
    }
    this.#maxLineBytes = maxLineBytes;
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /** Feeds one chunk and returns the values of every line it completed. */
  push(chunk: Uint8Array): unknown[] {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    const values: unknown[] = [];
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(LF, start);
      const end = newline === -1 ? bytes.length : newline;
      this.#append(bytes.subarray(start, end));
      if (newline === -1) break;
      this.#completeLine(values);
      start = newline + 1;
    }
    return values;
  }

  /** Flushes a final line that had no terminator. Call once when the stream ends. */
  end(): unknown[] {
    const values: unknown[] = [];
    if (this.#pendingBytes > 0 || this.#discarding) this.#completeLine(values);
    return values;
  }

  #append(segment: Buffer): void {
    if (segment.length === 0 || this.#discarding) return;
    // One extra byte is tolerated so a CRLF terminator split across chunks is not counted.
    if (this.#pendingBytes + segment.length > this.#maxLineBytes + 1) {
      this.#discarding = true;
      this.#pending = [];
      this.#pendingBytes = 0;
      return;
    }
    this.#pending.push(segment);
    this.#pendingBytes += segment.length;
  }

  #completeLine(values: unknown[]): void {
    this.#lineNumber += 1;
    const line = this.#lineNumber;
    let raw = Buffer.concat(this.#pending, this.#pendingBytes);
    const discarded = this.#discarding;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#discarding = false;

    if (raw.length > 0 && raw[raw.length - 1] === CR) raw = raw.subarray(0, raw.length - 1);
    if (discarded || raw.length > this.#maxLineBytes) {
      this.#warnings.push(`line ${line}: exceeds ${this.#maxLineBytes} bytes, dropped`);
      return;
    }

    let text: string;
    try {
      text = this.#decoder.decode(raw);
    } catch {
      this.#warnings.push(`line ${line}: invalid UTF-8, dropped`);
      return;
    }
    if (text.trim() === '') return;

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.#warnings.push(`line ${line}: not valid JSON, dropped`);
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.#warnings.push(`line ${line}: JSON value is not an object, dropped`);
      return;
    }
    values.push(value);
  }
}
