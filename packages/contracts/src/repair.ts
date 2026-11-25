import type { BrowserResult, BrowserStage } from './browser.ts';
import type { ComparisonEdge, Difference, EdgeSummary } from './comparison.ts';

/** Everything the coding agent sees. Values from the target are untrusted data, never instructions. */
export interface RepairRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly repairAttempt: number;
  readonly baseRevision: string;
  readonly allowedPaths: readonly string[];
  readonly hashes: {
    readonly config: string;
    readonly contract: string;
    readonly source: string;
  };
  readonly summaries: readonly EdgeSummary[];
  /** Bounded sample, grouped so every distinct failure shape appears at least once. */
  readonly differences: readonly Difference[];
  readonly totalDifferences: Readonly<Record<ComparisonEdge, number>>;
  readonly browser: Readonly<
    Partial<
      Record<
        BrowserStage,
        Pick<BrowserResult, 'outcome' | 'reasonCode' | 'oneLiner' | 'summary' | 'assertions' | 'failedStep'>
      >
    >
  >;
  readonly previousAttempts: readonly {
    readonly repairAttempt: number;
    readonly patchSha256: string | null;
    readonly result: string;
  }[];
}

export type RepairAgentStatus = 'patch' | 'no_patch' | 'agent_error' | 'timeout' | 'denied';

export interface RepairAgentResult {
  readonly status: RepairAgentStatus;
  readonly cause: string | null;
  readonly filesChanged: readonly string[];
  readonly durationMs: number;
  readonly costUsd: number | null;
  readonly models: readonly string[];
  readonly agentVersion: string | null;
  readonly turns: number | null;
  readonly error: string | null;
}

export type PatchRejectionCode =
  | 'EMPTY'
  | 'OUTSIDE_ALLOWED_PATHS'
  | 'PROTECTED_PATH'
  | 'BINARY'
  | 'SYMLINK'
  | 'MODE_CHANGE'
  | 'TOO_LARGE'
  | 'DUPLICATE_OF_PREVIOUS';

export interface PatchValidation {
  readonly ok: boolean;
  readonly sha256: string | null;
  readonly files: readonly string[];
  readonly linesChanged: number;
  readonly rejection: { readonly code: PatchRejectionCode; readonly detail: string } | null;
}
