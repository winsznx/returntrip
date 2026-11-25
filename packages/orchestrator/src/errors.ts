import type { RunOutcome } from '@returntrip/contracts';

/** A stop with a known outcome. Anything else that escapes the engine is EXECUTION_FAILED. */
export class RunStop extends Error {
  readonly outcome: RunOutcome;
  readonly code: string;

  constructor(outcome: RunOutcome, code: string, message: string) {
    super(message);
    this.name = 'RunStop';
    this.outcome = outcome;
    this.code = code;
  }
}
