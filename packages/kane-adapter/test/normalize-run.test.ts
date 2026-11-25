import { describe, expect, it } from 'vitest';

import { type KaneRunObservation, normalizeKaneRun } from '../src/normalize-run.ts';
import { loadRealRun, type RealRun } from './support/fixtures.ts';

const STARTED_AT = '2026-11-25T17:21:25.000Z';
const FINISHED_AT = '2026-11-25T17:22:10.000Z';

function observe(run: RealRun, exitCode: number): KaneRunObservation {
  const { events, stderr } = loadRealRun(run);
  return { events, stderr, exitCode, signal: null, startedAt: STARTED_AT, finishedAt: FINISHED_AT };
}

/** SYNTHETIC minimal stream: stream_start plus the given run_end payloads. */
function synthetic(runEnds: readonly Record<string, unknown>[], exitCode: number | null): KaneRunObservation {
  return {
    events: [
      { type: 'stream_start', cli_version: '0.10.9', surface: 'run', v: 1 },
      { step: 2, status: 'done', remark: 'navigate: x', ts: '2026-11-25T17:21:30.000Z' },
      ...runEnds.map((payload) => ({ type: 'run_end', ...payload })),
    ],
    exitCode,
    signal: null,
    stderr: '',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
  };
}

describe('normalizeKaneRun with real kane-cli 0.10.9 output', () => {
  it('maps the passing navigate-and-verify run to passed', () => {
    // #given pf02-1, which exited 0 with run_end status passed
    const observation = observe('pf02-1-pass', 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the outcome and Kane's own accounting are carried over
    expect(result).toMatchObject({
      outcome: 'passed',
      version: '0.10.9',
      reasonCode: 'success.complete',
      resultCode: '100',
      creditsUsed: 14.6040625,
      vendorDurationSec: 26.5,
      vendorSessionId: '28b26bc8-68c1-4c98-9ae2-f87362684e3e',
      failedStep: null,
      testUrl: 'https://test-manager.lambdatest.com/redacted',
      evidencePackPath:
        '/home/user/.testmuai/kaneai/sessions/28b26bc8-68c1-4c98-9ae2-f87362684e3e/evidence/59dea309-82e2-4f67-b103-96bdb0d20f46.evidence',
      protocolWarnings: [],
    });
  });

  it('collects assertion records and final state from the passing run', () => {
    // #given pf02-1, whose run_end memory holds two checks
    const observation = observe('pf02-1-pass', 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then each check becomes an assertion and final_state is kept as strings
    expect({ assertions: result.assertions, finalState: result.finalState }).toEqual({
      assertions: [
        {
          name: 'record_count_check',
          condition: "the page shows '3 records'",
          expected: '3 records',
          observed: '3 records',
          operator: 'equals',
        },
        {
          name: 'cafe_nunez_8710_row',
          condition: "a table row with vendor 'Café Núñez' and amount '87.10'",
          expected: 'true',
          observed: 'true',
          operator: 'equals',
        },
      ],
      finalState: {
        url: 'http://127.0.0.1:4100/w/source',
        record_count: '3 records',
        cafe_nunez_amount: '87.10',
      },
    });
  });

  it('counts only completed steps, never the running markers', () => {
    // #given pf02-1, with three running and three done progress lines
    const observation = observe('pf02-1-pass', 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the three done lines become steps with Kane's timestamps
    expect(result.steps.map(({ index, status, at }) => ({ index, status, at }))).toEqual([
      { index: 2, status: 'done', at: '2026-11-25T17:20:26.637Z' },
      { index: 3, status: 'done', at: '2026-11-25T17:20:45.820Z' },
      { index: 4, status: 'done', at: '2026-11-25T17:20:46.400Z' },
    ]);
  });

  it('maps the failing verification run to failed with its failed step and assertion', () => {
    // #given pf02-2, which exited 1 after the final assertion failed
    const observation = observe('pf02-2-fail', 1);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the failure is attributed to step 4 and the extracted value is kept as observed
    expect(result).toMatchObject({
      outcome: 'failed',
      reasonCode: 'assertion_error.final_verification',
      resultCode: '710',
      reason: 'Final verification failed: "the page shows \'5 records\'"',
      creditsUsed: 12.488399999999999,
      failedStep: { index: 4, status: 'failed', remark: "assert: the page shows '5 records'" },
      assertions: [
        {
          name: 'records_5_visible',
          condition: "the page shows '5 records'",
          expected: 'true',
          observed: 'false',
          operator: 'equals',
        },
      ],
      finalState: {},
      evidencePackPath:
        '/home/user/.testmuai/kaneai/sessions/fdd683af-c32d-4210-b421-ef31a86f945a/evidence/a3b683fa-25de-494c-b04e-7a546cb7ec15.evidence',
    });
  });

  it('maps the export click run to passed with its credits', () => {
    // #given pf04, which clicked Export CSV and exited 0
    const observation = observe('pf04-export', 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then it passes with four completed steps
    expect({
      outcome: result.outcome,
      credits: result.creditsUsed,
      steps: result.steps.length,
      session: result.vendorSessionId,
    }).toEqual({
      outcome: 'passed',
      credits: 16.0635425,
      steps: 4,
      session: 'f56b5bcc-aa1c-4db5-bbc7-7a38e3d76a34',
    });
  });

  it('maps the file upload run to passed with all three assertions', () => {
    // #given pf05, which uploaded a CSV through the file input and exited 0
    const observation = observe('pf05-upload', 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then it passes, with integer duration and every memory record as an assertion
    expect({
      outcome: result.outcome,
      credits: result.creditsUsed,
      duration: result.vendorDurationSec,
      assertions: result.assertions.map((assertion) => assertion.name),
      steps: result.steps.length,
    }).toEqual({
      outcome: 'passed',
      credits: 23.78807,
      duration: 55,
      assertions: ['zero_records_visible', 'import_successful_3_records_visible', 'three_records_visible'],
      steps: 7,
    });
  });

  it('falls back to the stderr evidence hint when no coverage event names the pack', () => {
    // #given pf02-1 with its coverage event removed
    const real = observe('pf02-1-pass', 0);
    const events = real.events.filter(
      (event) =>
        !(typeof event === 'object' && event !== null && 'type' in event && event.type === 'coverage'),
    );

    // #when it is normalized
    const result = normalizeKaneRun({ ...real, events });

    // #then the path comes from `kane-cli evidence serve <path>` on stderr, without the backtick
    expect(result.evidencePackPath).toBe(
      '/home/user/.testmuai/kaneai/sessions/28b26bc8-68c1-4c98-9ae2-f87362684e3e/evidence/59dea309-82e2-4f67-b103-96bdb0d20f46.evidence',
    );
  });
});

describe('normalizeKaneRun never defaults to passed', () => {
  it('reports unknown when run_end is missing', () => {
    // #given a stream that stopped before run_end, with exit 0
    const observation = synthetic([], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the outcome is unknown with a protocol warning
    expect([result.outcome, result.protocolWarnings]).toEqual(['unknown', ['run_end event missing']]);
  });

  it('reports unknown when run_end appears twice', () => {
    // #given two passing run_end events and exit 0
    const observation = synthetic([{ status: 'passed' }, { status: 'passed' }], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the duplicate terminal event makes the outcome unknown
    expect([result.outcome, result.protocolWarnings]).toEqual([
      'unknown',
      ['expected one run_end event, received 2'],
    ]);
  });

  it('reports unknown when exit 0 disagrees with a failed run_end', () => {
    // #given exit 0 but run_end status failed
    const observation = synthetic([{ status: 'failed' }], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then neither signal wins
    expect([result.outcome, result.protocolWarnings]).toEqual([
      'unknown',
      ['exit code 0 disagrees with run_end status failed'],
    ]);
  });

  it('reports unknown when exit 1 disagrees with a passed run_end', () => {
    // #given exit 1 but run_end status passed
    const observation = synthetic([{ status: 'passed' }], 1);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the outcome is unknown
    expect(result.outcome).toBe('unknown');
  });

  it('reports unknown for an exit code kane-cli does not document', () => {
    // #given a passing run_end but exit code 4
    const observation = synthetic([{ status: 'passed' }], 4);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the outcome is unknown
    expect(result.outcome).toBe('unknown');
  });

  it('reports infra_error for exit 2 with no events at all', () => {
    // #given a run refused before it started
    const observation: KaneRunObservation = {
      events: [],
      exitCode: 2,
      signal: null,
      stderr: 'error: not logged in\n',
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
    };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then it is an infrastructure failure with nothing invented
    expect(result).toMatchObject({
      outcome: 'infra_error',
      exitCode: 2,
      version: null,
      creditsUsed: null,
      steps: [],
      evidencePackPath: null,
      protocolWarnings: [],
    });
  });

  it('reports infra_error when kane-cli exits 3 on its own timeout', () => {
    // #given exit 3 without a ReturnTrip cancellation
    const observation = synthetic([], 3);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then it is infra_error, not canceled
    expect(result.outcome).toBe('infra_error');
  });

  it('reports canceled when ReturnTrip aborted the run, whatever the exit code', () => {
    // #given an aborted run that exited 3 after SIGTERM
    const observation = { ...synthetic([], 3), interruption: 'aborted' as const };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the caller's cancellation is reported
    expect(result.outcome).toBe('canceled');
  });

  it('reports infra_error when ReturnTrip had to kill an overdue run', () => {
    // #given a run killed by the adapter's own deadline
    const observation = { ...synthetic([{ status: 'passed' }], null), interruption: 'timed_out' as const };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then even a passed run_end cannot rescue it
    expect([result.outcome, result.protocolWarnings]).toEqual([
      'infra_error',
      ['kane-cli overran its deadline and was killed'],
    ]);
  });

  it('reports infra_error when an outside signal killed kane-cli', () => {
    // #given no exit code and SIGSEGV
    const observation = { ...synthetic([], null), signal: 'SIGSEGV' };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the crash is named
    expect([result.outcome, result.protocolWarnings]).toEqual([
      'infra_error',
      ['kane-cli terminated by SIGSEGV'],
    ]);
  });
});

describe('normalizeKaneRun field handling', () => {
  it('leaves credits null when run_end does not report them', () => {
    // #given a passing run_end with no credits field
    const observation = synthetic([{ status: 'passed' }], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then credits are unknown, not zero
    expect(result.creditsUsed).toBeNull();
  });

  it('accepts a string result_code and the legacy credits field', () => {
    // #given an older-style run_end
    const observation = synthetic([{ status: 'passed', result_code: '740', credits: 3.5 }], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then both are read
    expect([result.resultCode, result.creditsUsed]).toEqual(['740', 3.5]);
  });

  it('takes the session id from session_dir when there is no recording_state', () => {
    // #given a run_end carrying only session_dir
    const observation = synthetic([{ status: 'passed', session_dir: '/home/user/sessions/abc-123' }], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the directory name is the session id
    expect(result.vendorSessionId).toBe('abc-123');
  });

  it('surfaces kane warning and error events as protocol warnings', () => {
    // #given an unresolved-variable warning and an error event in a passing run
    const base = synthetic([{ status: 'passed' }], 0);
    const observation = {
      ...base,
      events: [
        { type: 'warning', code: 'unresolved_variables', message: '1 variable(s) have no value' },
        { type: 'error', message: 'upload failed' },
        ...base.events,
      ],
    };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then both are reported without changing the outcome
    expect([result.outcome, result.protocolWarnings]).toEqual([
      'passed',
      ['kane warning unresolved_variables: 1 variable(s) have no value', 'kane error: upload failed'],
    ]);
  });

  it('flags a kane-cli version that was never verified against fixtures', () => {
    // #given a stream from a newer release
    const base = synthetic([{ status: 'passed' }], 0);
    const observation = {
      ...base,
      events: [{ type: 'stream_start', cli_version: '0.11.0', v: 1 }, ...base.events.slice(1)],
    };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then the version is recorded and called out
    expect([result.version, result.protocolWarnings]).toEqual([
      '0.11.0',
      ['kane-cli 0.11.0 has not been verified against captured fixtures'],
    ]);
  });

  it('carries parser warnings ahead of its own', () => {
    // #given a warning from the NDJSON parser and a missing run_end
    const observation = { ...synthetic([], 0), protocolWarnings: ['line 3: not valid JSON, dropped'] };

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then both are reported in order
    expect(result.protocolWarnings).toEqual(['line 3: not valid JSON, dropped', 'run_end event missing']);
  });

  it('measures wall-clock duration from the timestamps it was given', () => {
    // #given a run observed for 45 seconds
    const observation = synthetic([{ status: 'passed' }], 0);

    // #when it is normalized
    const result = normalizeKaneRun(observation);

    // #then durationMs is the difference
    expect(result.durationMs).toBe(45_000);
  });
});
