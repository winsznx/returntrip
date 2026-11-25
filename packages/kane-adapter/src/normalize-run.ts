import { basename } from 'node:path';

import type { AssertionRecord, BrowserOutcome, BrowserResult, BrowserStep } from '@returntrip/contracts';

import {
  asProgressEvent,
  displayValue,
  eventType,
  finiteNumberField,
  isJsonObject,
  type JsonObject,
  objectField,
  stringField,
} from './kane-events.ts';

/** kane-cli releases whose stream this adapter was verified against with captured fixtures. */
export const VERIFIED_KANE_VERSIONS: readonly string[] = ['0.10.9'];

const STREAM_CONTRACT_VERSION = 1;
const EVIDENCE_HINT = /kane-cli evidence serve (\S+\.evidence)/;

/** kane-cli 0.10.9 exit codes. */
const EXIT_PASSED = 0;
const EXIT_FAILED = 1;
const EXIT_NOT_STARTED = 2;
const EXIT_TIMEOUT_OR_CANCELED = 3;

/**
 * Why ReturnTrip stopped the process itself, if it did. `aborted` is a caller cancellation,
 * `timed_out` is the adapter's own hard deadline firing because Kane did not stop on time.
 */
export type KaneInterruption = 'aborted' | 'timed_out';

export interface KaneRunObservation {
  readonly events: readonly unknown[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly interruption?: KaneInterruption | null;
  /** Warnings raised before normalization, such as dropped NDJSON lines. */
  readonly protocolWarnings?: readonly string[];
}

interface OutcomeDecision {
  readonly outcome: BrowserOutcome;
  readonly warning: string | null;
}

/**
 * Maps one observed kane-cli run to a BrowserResult. Pure: same input, same output.
 * A pass requires exit code 0 and exactly one `run_end` reporting `passed`; anything less
 * certain becomes `unknown`, `infra_error` or `canceled`, never `passed`.
 */
export function normalizeKaneRun(observation: KaneRunObservation): BrowserResult {
  const warnings: string[] = [...(observation.protocolWarnings ?? [])];
  const { events } = observation;

  const streamStart = lastTypedEvent(events, 'stream_start');
  const runEnds = events.filter((event): event is JsonObject => eventType(event) === 'run_end');
  const runEnd = runEnds.at(-1) ?? null;

  const version = streamStart ? stringField(streamStart, 'cli_version') : null;
  if (!streamStart) {
    if (events.length > 0) warnings.push('stream_start event missing');
  } else {
    const contract = streamStart.v;
    if (contract !== STREAM_CONTRACT_VERSION) {
      warnings.push(`unsupported stream contract version ${displayValue(contract) ?? 'absent'}`);
    }
    if (version !== null && !VERIFIED_KANE_VERSIONS.includes(version)) {
      warnings.push(`kane-cli ${version} has not been verified against captured fixtures`);
    }
  }

  for (const event of events) {
    const type = eventType(event);
    if (!isJsonObject(event) || (type !== 'warning' && type !== 'error')) continue;
    const code = stringField(event, 'code');
    const message = stringField(event, 'message') ?? '(no message)';
    warnings.push(`kane ${type}${code ? ` ${code}` : ''}: ${message}`);
  }

  const decision = decideOutcome(observation, runEnds.length, runEnd);
  if (decision.warning) warnings.push(decision.warning);

  const steps = collectSteps(events, observation.finishedAt);
  const failedStep = steps.findLast((step) => step.status === 'failed') ?? null;

  return {
    vendor: 'kane-cli',
    version,
    outcome: decision.outcome,
    exitCode: observation.exitCode,
    signal: observation.signal,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
    durationMs: elapsedMs(observation.startedAt, observation.finishedAt),
    vendorDurationSec: runEnd ? finiteNumberField(runEnd, 'duration') : null,
    vendorSessionId: sessionId(events, runEnd),
    reasonCode: runEnd ? stringField(runEnd, 'reason_code') : null,
    resultCode: runEnd ? displayScalar(runEnd.result_code) : null,
    reason: runEnd ? stringField(runEnd, 'reason') : null,
    summary: runEnd ? stringField(runEnd, 'summary') : null,
    oneLiner: runEnd ? stringField(runEnd, 'one_liner') : null,
    creditsUsed: runEnd ? creditsUsed(runEnd) : null,
    steps,
    failedStep,
    assertions: runEnd ? collectAssertions(runEnd) : [],
    finalState: runEnd ? collectFinalState(runEnd) : {},
    testUrl: runEnd ? stringField(runEnd, 'test_url') : null,
    evidencePackPath: evidencePackPath(events, observation.stderr),
    protocolWarnings: warnings,
  };
}

function decideOutcome(
  observation: KaneRunObservation,
  runEndCount: number,
  runEnd: JsonObject | null,
): OutcomeDecision {
  const { exitCode, signal, interruption } = observation;
  if (interruption === 'aborted') return { outcome: 'canceled', warning: null };
  if (interruption === 'timed_out') {
    return { outcome: 'infra_error', warning: 'kane-cli overran its deadline and was killed' };
  }
  if (exitCode === null) {
    return { outcome: 'infra_error', warning: `kane-cli terminated by ${signal ?? 'an unknown signal'}` };
  }
  if (exitCode === EXIT_NOT_STARTED) return { outcome: 'infra_error', warning: null };
  if (exitCode === EXIT_TIMEOUT_OR_CANCELED) {
    return { outcome: 'infra_error', warning: 'kane-cli reported a timeout or cancellation (exit 3)' };
  }
  if (runEndCount === 0) return { outcome: 'unknown', warning: 'run_end event missing' };
  if (runEndCount > 1) {
    return { outcome: 'unknown', warning: `expected one run_end event, received ${runEndCount}` };
  }

  const status = runEnd ? stringField(runEnd, 'status') : null;
  if (exitCode === EXIT_PASSED && status === 'passed') return { outcome: 'passed', warning: null };
  if (exitCode === EXIT_FAILED && status === 'failed') return { outcome: 'failed', warning: null };
  return {
    outcome: 'unknown',
    warning: `exit code ${exitCode} disagrees with run_end status ${status ?? '(absent)'}`,
  };
}

function lastTypedEvent(events: readonly unknown[], type: string): JsonObject | null {
  const event = events.findLast((candidate) => eventType(candidate) === type);
  return isJsonObject(event) ? event : null;
}

function collectSteps(events: readonly unknown[], finishedAt: string): BrowserStep[] {
  const steps: BrowserStep[] = [];
  for (const event of events) {
    const progress = asProgressEvent(event);
    if (!progress || (progress.status !== 'done' && progress.status !== 'failed')) continue;
    steps.push({
      index: progress.step,
      status: progress.status,
      remark: progress.remark,
      // Streams before the 0.8.17 contract carry no `ts`; run end is a safe upper bound.
      at: progress.ts ?? finishedAt,
    });
  }
  return steps;
}

function collectAssertions(runEnd: JsonObject): AssertionRecord[] {
  const context = objectField(runEnd, 'context');
  const records = context ? objectField(context, 'memory') : null;
  if (!records) return [];
  const assertions: AssertionRecord[] = [];
  for (const [name, record] of Object.entries(records)) {
    if (!isJsonObject(record)) continue;
    assertions.push({
      name,
      condition: displayValue(record.condition),
      expected: displayValue(record.expected_value),
      observed: displayValue(record.extracted_value),
      operator: displayValue(record.operator),
    });
  }
  return assertions;
}

function collectFinalState(runEnd: JsonObject): Record<string, string> {
  const finalState = objectField(runEnd, 'final_state');
  const state: Record<string, string> = {};
  if (!finalState) return state;
  for (const [key, value] of Object.entries(finalState)) {
    const text = displayValue(value);
    if (text !== null) state[key] = text;
  }
  return state;
}

function creditsUsed(runEnd: JsonObject): number | null {
  // Releases before `credits_consumed` named the same figure `credits`.
  const credits = finiteNumberField(runEnd, 'credits_consumed') ?? finiteNumberField(runEnd, 'credits');
  return credits !== null && credits >= 0 ? credits : null;
}

function sessionId(events: readonly unknown[], runEnd: JsonObject | null): string | null {
  const recording = lastTypedEvent(events, 'recording_state');
  const fromRecording = recording ? stringField(recording, 'session_id') : null;
  if (fromRecording) return fromRecording;
  const sessionDir = runEnd ? stringField(runEnd, 'session_dir') : null;
  return sessionDir ? basename(sessionDir) || null : null;
}

function evidencePackPath(events: readonly unknown[], stderr: string): string | null {
  const fromCoverage = events
    .filter((event): event is JsonObject => eventType(event) === 'coverage')
    .map((event) => stringField(event, 'pack'))
    .findLast((pack): pack is string => pack !== null && pack !== '');
  if (fromCoverage) return fromCoverage;
  return EVIDENCE_HINT.exec(stderr)?.[1] ?? null;
}

function displayScalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}
