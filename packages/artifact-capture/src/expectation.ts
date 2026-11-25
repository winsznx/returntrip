import { CaptureError } from './capture-error.ts';

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CaptureError };

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: CaptureError) => void;
  readonly timer: NodeJS.Timeout;
}

/** What a caller holds while one stage's transfer is expected. */
export interface PendingCapture<T> {
  readonly stage: string;
  readonly workspace: string;
  /**
   * Resolves with the single complete matching transfer. The expectation window closes when
   * this settles, so call it once the browser step has finished: a second matching transfer
   * before that point rejects with AMBIGUOUS, one after it is only logged as unexpected.
   */
  wait(timeoutMs: number): Promise<T>;
  /** Closes the window and rejects any pending `wait` with CANCELED. */
  cancel(): void;
}

/**
 * One expectation window. It accepts exactly one matching transfer; failures win over
 * success, and the first failure is the one reported.
 */
export class Expectation<T> implements PendingCapture<T> {
  readonly stage: string;
  readonly workspace: string;
  readonly armedAt: number;
  readonly #onClose: () => void;
  #open = true;
  #matches = 0;
  #inFlight: (() => void) | null = null;
  #outcome: Settled<T> | null = null;
  #waiters: Waiter<T>[] = [];

  constructor(stage: string, workspace: string, onClose: () => void) {
    this.stage = stage;
    this.workspace = workspace;
    this.armedAt = Date.now();
    this.#onClose = onClose;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /**
   * Registers a matching transfer. Returns true when it should be recorded; false when it is
   * the second match, which fails the expectation as AMBIGUOUS and aborts the first recording.
   */
  claim(abort: () => void): boolean {
    this.#matches += 1;
    if (this.#matches === 1) {
      this.#inFlight = abort;
      return true;
    }
    this.#abortInFlight();
    this.fail(new CaptureError('AMBIGUOUS', `more than one matching transfer for stage ${this.stage}`));
    return false;
  }

  succeed(value: T): void {
    if (!this.#open) return;
    this.#inFlight = null;
    this.#outcome ??= { ok: true, value };
    this.#flush();
  }

  fail(error: CaptureError): void {
    if (!this.#open) return;
    this.#inFlight = null;
    if (!this.#outcome || this.#outcome.ok) this.#outcome = { ok: false, error };
    this.#flush();
  }

  wait(timeoutMs: number): Promise<T> {
    if (!this.#open) return this.#replay();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#abortInFlight();
        this.fail(
          new CaptureError('TIMEOUT', `no complete transfer for stage ${this.stage} within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      this.#waiters.push({ resolve, reject, timer });
      this.#flush();
    });
  }

  cancel(): void {
    if (!this.#open) return;
    this.#abortInFlight();
    this.#outcome = {
      ok: false,
      error: new CaptureError('CANCELED', `expectation for stage ${this.stage} canceled`),
    };
    this.#close();
  }

  #abortInFlight(): void {
    const abort = this.#inFlight;
    this.#inFlight = null;
    abort?.();
  }

  #flush(): void {
    if (this.#open && this.#outcome && !this.#inFlight && this.#waiters.length > 0) this.#close();
  }

  #close(): void {
    this.#open = false;
    const outcome = this.#outcome;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (outcome?.ok) waiter.resolve(outcome.value);
      else waiter.reject(outcome?.error ?? new CaptureError('CANCELED', 'expectation closed'));
    }
    this.#onClose();
  }

  #replay(): Promise<T> {
    const outcome = this.#outcome;
    if (outcome?.ok) return Promise.resolve(outcome.value);
    return Promise.reject(outcome?.error ?? new CaptureError('CANCELED', 'expectation closed'));
  }
}
