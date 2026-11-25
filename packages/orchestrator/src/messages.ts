import type { RunOutcome } from '@returntrip/contracts';

/** One plain sentence per outcome, used when there are no numbers to say something sharper. */
export const OUTCOME_TEXT: Readonly<Record<RunOutcome, string>> = {
  VERIFIED: 'Every record came back exactly as it went out.',
  REPAIRED_VERIFIED: 'The agent fixed the app, and a fresh round trip came back exactly as it went out.',
  DATA_MISMATCH: 'The app reported success, but the data that came back is different.',
  REPAIR_UNRESOLVED: 'The data came back different, and the agent did not produce a fix that passed.',
  EXECUTION_FAILED: 'The run could not finish, so there is no verdict on the data.',
  INCONCLUSIVE: 'The evidence was not complete enough to call it either way.',
  INVALID_CONFIG: 'The configuration is not valid, so nothing ran.',
  BUDGET_EXCEEDED: 'The run stopped at its credit budget before it could finish.',
  CANCELED: 'The run was canceled. There is no verdict.',
};

export function groupedNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
