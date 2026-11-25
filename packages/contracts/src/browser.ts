/**
 * Vendor-neutral shape of one browser journey stage. These are ReturnTrip's normalized fields,
 * built from what kane-cli actually emits; they are not Kane's own schema.
 */
export const BROWSER_STAGES = ['export', 'create-destination', 'restore', 'reexport'] as const;
export type BrowserStage = (typeof BROWSER_STAGES)[number];

export interface BrowserObjective {
  readonly runId: string;
  readonly attempt: number;
  readonly stage: BrowserStage;
  readonly objective: string;
  readonly url: string;
  readonly timeoutMs: number;
}

export type BrowserOutcome = 'passed' | 'failed' | 'infra_error' | 'unknown' | 'canceled';

export interface BrowserStep {
  readonly index: number;
  readonly status: 'done' | 'failed';
  readonly remark: string;
  readonly at: string;
}

export interface AssertionRecord {
  readonly name: string;
  readonly condition: string | null;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly operator: string | null;
}

export interface BrowserResult {
  readonly vendor: 'kane-cli';
  readonly version: string | null;
  readonly outcome: BrowserOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** Agent time Kane itself reports, separate from our wall clock. */
  readonly vendorDurationSec: number | null;
  readonly vendorSessionId: string | null;
  readonly reasonCode: string | null;
  readonly resultCode: string | null;
  readonly reason: string | null;
  readonly summary: string | null;
  readonly oneLiner: string | null;
  readonly creditsUsed: number | null;
  readonly steps: readonly BrowserStep[];
  readonly failedStep: BrowserStep | null;
  readonly assertions: readonly AssertionRecord[];
  readonly finalState: Readonly<Record<string, string>>;
  readonly testUrl: string | null;
  /** Path of the sealed evidence pack Kane wrote, when one exists. */
  readonly evidencePackPath: string | null;
  readonly protocolWarnings: readonly string[];
  /** Kane's own verdict on its sealed evidence pack against ReturnTrip's stage policy, when judged. */
  readonly evidenceVerdict?: EvidenceVerdict | null;
}

export interface EvidenceVerdict {
  readonly policy: string;
  readonly result: 'pass' | 'fail' | 'errored';
  readonly failedGates: readonly string[];
  readonly warnedGates: readonly string[];
  readonly erroredGates: readonly string[];
}
