import type {
  BrowserStage,
  ComparisonEdge,
  Difference,
  DifferenceKind,
  EdgeSummary,
  RunEvent,
  RunOutcome,
  RunPhase,
} from '@returntrip/contracts';
import type {
  AttemptReport,
  ManifestEntry,
  PublicIndexEntry,
  PublicRun,
  PublicScreenshot,
  RunReport,
  StageReport,
} from '@returntrip/reporting';

export type {
  AttemptReport,
  BrowserStage,
  ComparisonEdge,
  Difference,
  DifferenceKind,
  EdgeSummary,
  ManifestEntry,
  PublicIndexEntry,
  PublicRun,
  PublicScreenshot,
  RunEvent,
  RunOutcome,
  RunPhase,
  RunReport,
  StageReport,
};

export type RepairEntry = RunReport['repairs'][number];

/** The run row as GET /api/v1/runs and /api/v1/runs/:id return it. */
export interface ApiRun {
  readonly id: string;
  readonly project: string;
  readonly mode: 'verify' | 'repair';
  readonly status: 'active' | 'finished';
  readonly phase: RunPhase;
  readonly outcome: RunOutcome | null;
  readonly headline: string | null;
  readonly failureCode: string | null;
  readonly configPath: string;
  readonly fromRunId: string | null;
  readonly activeAttempt: number;
  readonly kaneVersion: string | null;
  readonly kaneCreditsUsed: number;
  readonly agentUsd: number;
  readonly budget: {
    readonly maxKaneCredits: number;
    readonly maxRepairAttempts: number;
    readonly maxAgentBudgetUsd: number;
  };
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunDetail {
  readonly run: ApiRun;
  readonly outcomeText: string | null;
  readonly active: boolean;
  readonly report: RunReport;
}

export interface RunPage {
  readonly runs: readonly ApiRun[];
  readonly nextCursor: string | null;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly configPath: string;
  readonly mode: 'managed' | 'attached';
  readonly repairEnabled: boolean;
  readonly scenario: RunReport['scenario'];
  readonly sourceRows: number | null;
  readonly sourceSha256: string;
  readonly fields: readonly { readonly name: string; readonly type: string }[];
  readonly identity: string;
  readonly limits: {
    readonly browserRunTimeoutMs: number;
    readonly overallTimeoutMs: number;
    readonly maxRepairAttempts: number;
    readonly maxBrowserRetries: number;
    readonly maxRows: number;
    readonly maxKaneCredits: number;
  };
  readonly repairPaths: readonly string[];
  readonly activeRunId: string | null;
}

export interface DifferencePage {
  readonly differences: readonly Difference[];
  readonly total: number;
}

export interface PublicIndex {
  readonly schemaVersion: 1;
  readonly runs: readonly PublicIndexEntry[];
}
