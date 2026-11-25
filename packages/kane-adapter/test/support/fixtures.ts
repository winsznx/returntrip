import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NdjsonParser } from '../../src/ndjson-parser.ts';

export const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures');
export const KANE_FIXTURE_DIR = join(FIXTURE_DIR, 'kane-0.10.9');
export const FAKE_KANE = join(FIXTURE_DIR, 'fake-kane.mjs');

export type RealRun = 'pf02-1-pass' | 'pf02-2-fail' | 'pf04-export' | 'pf05-upload';

export function fixturePath(run: RealRun, stream: 'ndjson' | 'stderr'): string {
  return join(KANE_FIXTURE_DIR, `${run}.${stream}`);
}

export interface RealRunCapture {
  readonly events: unknown[];
  readonly stderr: string;
}

/** Parses a captured run exactly as the runner would, from the raw stdout bytes. */
export function loadRealRun(run: RealRun): RealRunCapture {
  const parser = new NdjsonParser();
  const events = [...parser.push(readFileSync(fixturePath(run, 'ndjson'))), ...parser.end()];
  if (parser.warnings.length > 0) throw new Error(`fixture ${run} has parse warnings: ${parser.warnings}`);
  return { events, stderr: readFileSync(fixturePath(run, 'stderr'), 'utf8') };
}
