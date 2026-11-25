import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseVerdict } from '../src/index.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kane-0.10.9', 'verdict-pass.json');

describe('parseVerdict', () => {
  it('reads a real kane-cli 0.10.9 passing verdict for the stage policy', async () => {
    // #given the JSON Kane printed for `evidence verdict --policy returntrip-stage.yaml --json`
    const stdout = await readFile(FIXTURE, 'utf8');

    // #when
    const verdict = parseVerdict(stdout, 'returntrip-stage');

    // #then
    expect(verdict).toEqual({
      policy: 'returntrip-stage',
      result: 'pass',
      failedGates: [],
      warnedGates: [],
      erroredGates: [],
    });
  });

  it('lists the gates that failed', () => {
    // #given a failing verdict (synthetic, shaped like Kane's)
    const stdout = JSON.stringify({
      result: 'fail',
      policies: [{ id: 'returntrip-stage' }],
      verdicts: [
        {
          gates: [
            { id: 'asserted-something', status: 'fail' },
            { id: 'no-heals', status: 'warn' },
            { id: 'run-finalized', status: 'pass' },
          ],
        },
      ],
    });

    // #when
    const verdict = parseVerdict(stdout, 'returntrip-stage');

    // #then
    expect({ result: verdict.result, failed: verdict.failedGates, warned: verdict.warnedGates }).toEqual({
      result: 'fail',
      failed: ['asserted-something'],
      warned: ['no-heals'],
    });
  });

  it('treats unreadable output as an errored verdict, never a pass', () => {
    // #given
    const stdout = 'Error: pack not found';

    // #when
    const verdict = parseVerdict(stdout, 'returntrip-stage');

    // #then
    expect(verdict.result).toBe('errored');
  });
});
