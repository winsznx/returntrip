import type { BrowserResult, BrowserStage, CaptureConfig, RepairAgentResult } from '@returntrip/contracts';

/** Drives one plain-English browser objective. The real implementation is Kane CLI. */
export interface BrowserDriver {
  readonly name: string;
  version(): Promise<string | null>;
  balance(): Promise<number | null>;
  run(input: {
    readonly stage: BrowserStage;
    readonly objective: string;
    readonly url: string;
    readonly timeoutMs: number;
    readonly cwd: string;
    readonly logDir: string;
    readonly signal: AbortSignal;
    readonly onProgress: (progress: { step: number; status: string; remark: string }) => void;
    readonly variablesFile?: string;
  }): Promise<{
    readonly result: BrowserResult;
    readonly stdoutPath: string | null;
    readonly stderrPath: string | null;
  }>;
}

export interface CapturedFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string | null;
  readonly contentDisposition: string | null;
  readonly status: number;
  readonly capturedAt: string;
}

export interface ObservedUpload {
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string | null;
  readonly wholeBody: boolean;
}

export interface CaptureSession {
  readonly origin: string;
  expectExport(
    stage: string,
    workspace: string,
  ): { wait(timeoutMs: number): Promise<CapturedFile>; cancel(): void };
  expectRestore(
    stage: string,
    workspace: string,
  ): { wait(timeoutMs: number): Promise<ObservedUpload>; cancel(): void };
  requestLog(): readonly unknown[];
  close(): Promise<void>;
}

export interface CaptureDriver {
  start(input: {
    readonly upstream: string;
    readonly capture: CaptureConfig;
    readonly artifactDir: string;
  }): Promise<CaptureSession>;
}

export interface RepairDriver {
  version(): Promise<string | null>;
  repair(input: {
    readonly dir: string;
    readonly prompt: string;
    readonly timeoutMs: number;
    readonly maxBudgetUsd: number;
    readonly logDir: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly result: RepairAgentResult; readonly rawPath: string | null }>;
}

export interface EngineDeps {
  readonly browser: BrowserDriver;
  readonly capture: CaptureDriver;
  readonly repair: RepairDriver;
}
