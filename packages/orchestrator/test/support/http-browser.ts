import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserResult, BrowserStage } from '@returntrip/contracts';

import type { BrowserDriver, RepairDriver } from '../../src/index.ts';

/**
 * Test double for Kane CLI. It performs each journey stage with plain HTTP requests through the
 * capture proxy, the same requests the demo app receives from a browser. It is never used for
 * live results; it lets the engine be tested end to end without spending credits.
 */
export function httpBrowser(
  options: { failStage?: BrowserStage; creditsPerStage?: number } = {},
): BrowserDriver {
  const credits = options.creditsPerStage ?? 10;
  return {
    name: 'http-test-double',
    version: async () => '0.10.9',
    balance: async () => 10_000,
    async run(input) {
      const startedAt = new Date().toISOString();
      const url = new URL(input.url);
      const origin = url.origin;
      let ok = input.stage !== options.failStage;
      if (ok) {
        if (input.stage === 'export' || input.stage === 'reexport') {
          const response = await fetch(`${input.url.replace(/\/$/, '')}/export.csv`);
          await response.arrayBuffer();
          ok = response.ok;
        } else if (input.stage === 'create-destination') {
          const name = /'(restore-[^']+)'/.exec(input.objective)?.[1] ?? '';
          const response = await fetch(`${origin}/workspaces`, {
            method: 'POST',
            body: new URLSearchParams({ name }),
            redirect: 'manual',
          });
          ok = response.status === 303;
        } else {
          const file = /upload the file (\S+)/i.exec(input.objective)?.[1] ?? '';
          const form = new FormData();
          form.set('file', new Blob([await readFile(file)], { type: 'text/csv' }), 'export.csv');
          const response = await fetch(`${input.url.replace(/\/$/, '')}/import`, {
            method: 'POST',
            body: form,
            redirect: 'manual',
          });
          ok = response.status === 303;
        }
      }
      input.onProgress({ step: 1, status: ok ? 'done' : 'failed', remark: `${input.stage} via HTTP` });
      const finishedAt = new Date().toISOString();
      const result: BrowserResult = {
        vendor: 'kane-cli',
        version: '0.10.9',
        outcome: ok ? 'passed' : 'failed',
        exitCode: ok ? 0 : 1,
        signal: null,
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        vendorDurationSec: null,
        vendorSessionId: null,
        reasonCode: ok ? 'success.complete' : 'assertion_error.final_verification',
        resultCode: ok ? '100' : '710',
        reason: ok ? 'Objective completed' : 'Final verification failed',
        summary: null,
        oneLiner: ok ? `${input.stage} done` : `${input.stage} failed`,
        creditsUsed: credits,
        steps: [],
        failedStep: null,
        assertions: [],
        finalState: {},
        testUrl: null,
        evidencePackPath: null,
        protocolWarnings: [],
      };
      const stdoutPath = join(input.logDir, 'kane.stdout.ndjson');
      await writeFile(stdoutPath, `${JSON.stringify({ type: 'run_end', status: result.outcome })}\n`);
      return { result, stdoutPath, stderrPath: null };
    },
  };
}

/** Test double for the coding agent: applies a fixed edit to one file in the target copy. */
export function scriptedRepair(edit: {
  file: string;
  from: string;
  to: string;
  cause: string;
}): RepairDriver {
  return {
    version: async () => '2.1.326',
    async repair(input) {
      const path = join(input.dir, edit.file);
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(edit.from, edit.to));
      return {
        result: {
          status: 'patch',
          cause: edit.cause,
          filesChanged: [edit.file],
          durationMs: 5,
          costUsd: 0.1,
          models: ['test-double'],
          agentVersion: '2.1.326',
          turns: 1,
          error: null,
        },
        rawPath: null,
      };
    },
  };
}
