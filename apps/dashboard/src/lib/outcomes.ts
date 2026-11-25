import type { RunOutcome, StageReport } from './types.ts';

/**
 * ok: the data came back. bad: the data did not come back. warn: no data verdict was reached.
 * neutral: still running, or stopped on purpose.
 */
export type Tone = 'ok' | 'bad' | 'warn' | 'neutral';
export type OutcomeIcon =
  | 'check'
  | 'repaired'
  | 'cross'
  | 'unresolved'
  | 'alert'
  | 'question'
  | 'stop'
  | 'pending';

export interface OutcomeMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: OutcomeIcon;
  /** One plain sentence for people who have never seen the code. */
  readonly meaning: string;
}

export const OUTCOME_META: Readonly<Record<RunOutcome, OutcomeMeta>> = {
  VERIFIED: {
    label: 'Verified',
    tone: 'ok',
    icon: 'check',
    meaning: 'Every record came back the same as the trusted source.',
  },
  REPAIRED_VERIFIED: {
    label: 'Repaired and verified',
    tone: 'ok',
    icon: 'repaired',
    meaning: 'Data broke, Claude Code patched a copy, and the same journey then came back clean.',
  },
  DATA_MISMATCH: {
    label: 'Data mismatch',
    tone: 'bad',
    icon: 'cross',
    meaning: 'Some records did not come back the same as the trusted source.',
  },
  REPAIR_UNRESOLVED: {
    label: 'Repair unresolved',
    tone: 'bad',
    icon: 'unresolved',
    meaning: 'Data broke and no accepted patch made the journey come back clean.',
  },
  EXECUTION_FAILED: {
    label: 'Run failed',
    tone: 'warn',
    icon: 'alert',
    meaning: 'The journey did not finish, so there is no data verdict.',
  },
  INCONCLUSIVE: {
    label: 'Inconclusive',
    tone: 'warn',
    icon: 'question',
    meaning: 'The evidence was not enough to decide either way.',
  },
  INVALID_CONFIG: {
    label: 'Invalid config',
    tone: 'warn',
    icon: 'alert',
    meaning: 'The config did not pass checks, so nothing ran.',
  },
  BUDGET_EXCEEDED: {
    label: 'Budget reached',
    tone: 'warn',
    icon: 'stop',
    meaning: 'The run stopped at its credit or spend cap before a verdict.',
  },
  CANCELED: {
    label: 'Canceled',
    tone: 'neutral',
    icon: 'stop',
    meaning: 'Someone stopped the run before a verdict.',
  },
};

export const RUNNING_META: OutcomeMeta = {
  label: 'Running',
  tone: 'neutral',
  icon: 'pending',
  meaning: 'The run is still going.',
};

const UNKNOWN_META: OutcomeMeta = {
  label: 'No outcome',
  tone: 'warn',
  icon: 'question',
  meaning: 'This run ended without a recorded outcome.',
};

export function isRunOutcome(value: string | null): value is RunOutcome {
  return value !== null && Object.hasOwn(OUTCOME_META, value);
}

export function outcomeMeta(outcome: string | null, active = false): OutcomeMeta {
  if (active && outcome === null) return RUNNING_META;
  return isRunOutcome(outcome) ? OUTCOME_META[outcome] : UNKNOWN_META;
}

export function stageTone(outcome: StageReport['outcome']): Tone {
  switch (outcome) {
    case 'passed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'canceled':
      return 'neutral';
    default:
      return 'warn';
  }
}

export const STAGE_LABELS: Readonly<Record<string, string>> = {
  export: 'Export',
  'create-destination': 'Create empty workspace',
  restore: 'Restore',
  reexport: 'Export again',
};

export const KANE_OUTCOME_LABELS: Readonly<Record<StageReport['outcome'], string>> = {
  passed: 'Kane passed',
  failed: 'Kane failed',
  infra_error: 'Infrastructure error',
  unknown: 'Unknown',
  canceled: 'Canceled',
};
