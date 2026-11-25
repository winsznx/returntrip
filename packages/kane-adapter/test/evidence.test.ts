import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyEvidencePack, summarizeEvidence } from '../src/evidence.ts';
import { DEFAULT_ZIP_LIMITS, parseZip } from '../src/zip-reader.ts';
import { buildZip, type SyntheticEntry } from './support/zip-builder.ts';

const TEST = 'tests/go-to-http-127-0-0-1-4100-w-source-and-v-dad84d70';

/**
 * SYNTHETIC pack laid out like the real kane-cli 0.10.9 pack from run pf02-2. The real pack is
 * not committed because it holds account details and a share link.
 */
function syntheticKanePack(extra: readonly SyntheticEntry[] = []): Buffer {
  const har = {
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-11-25T17:21:35.764285+00:00',
          request: { method: 'GET', url: 'http://127.0.0.1:4100/w/source', headers: [] },
          response: { status: 200, content: { mimeType: 'text/html; charset=utf-8' } },
        },
        {
          startedDateTime: '2026-11-25T17:21:40.000000+00:00',
          request: {
            method: 'GET',
            url: 'http://127.0.0.1:4100/w/source/export.csv?sig=secret',
            headers: [],
          },
          response: { status: 200, content: { mimeType: 'text/csv' } },
        },
      ],
    },
  };
  return buildZip([
    { name: 'run.yaml', data: "evidence: '0.1'\nstatus: finalized\n" },
    { name: `${TEST}/logs/0-network.har`, data: JSON.stringify(har) },
    { name: `${TEST}/steps/1-0-1/screenshot.jpg`, data: 'jpeg-1', method: 'stored' },
    { name: `${TEST}/steps/1-0-1/step.json`, data: '{"kind":"navigate","status":"passed"}' },
    { name: `${TEST}/steps/2-0-2/screenshot.jpg`, data: 'jpeg-2', method: 'stored' },
    { name: `${TEST}/steps/2-0-2/step.json`, data: '{"kind":"analyze","status":"passed"}' },
    { name: `${TEST}/steps/3-0-3/failure.yaml`, data: 'step: 0-3\n' },
    { name: `${TEST}/steps/3-0-3/screenshot.jpg`, data: 'jpeg-3', method: 'stored' },
    { name: `${TEST}/steps/3-0-3/step.json`, data: '{"kind":"assert","status":"failed"}' },
    ...extra,
  ]);
}

describe('summarizeEvidence', () => {
  it('lists screenshots per step in ordinal order with each step status', () => {
    // #given a synthetic pack in Kane's layout
    const pack = parseZip(syntheticKanePack(), DEFAULT_ZIP_LIMITS);

    // #when it is summarized
    const summary = summarizeEvidence(pack);

    // #then each step directory appears once with its screenshot
    expect(
      summary.steps.map(({ step, ordinal, status, screenshots }) => ({ step, ordinal, status, screenshots })),
    ).toEqual([
      { step: '1-0-1', ordinal: 1, status: 'passed', screenshots: [`${TEST}/steps/1-0-1/screenshot.jpg`] },
      { step: '2-0-2', ordinal: 2, status: 'passed', screenshots: [`${TEST}/steps/2-0-2/screenshot.jpg`] },
      { step: '3-0-3', ordinal: 3, status: 'failed', screenshots: [`${TEST}/steps/3-0-3/screenshot.jpg`] },
    ]);
  });

  it('names the screenshot of the failed step', () => {
    // #given a pack whose third step failed
    const pack = parseZip(syntheticKanePack(), DEFAULT_ZIP_LIMITS);

    // #when it is summarized
    const summary = summarizeEvidence(pack);

    // #then the failed step's screenshot is singled out
    expect(summary.failedStepScreenshot).toBe(`${TEST}/steps/3-0-3/screenshot.jpg`);
  });

  it('lists HAR requests with query strings removed', () => {
    // #given a HAR containing an export URL with a signature parameter
    const pack = parseZip(syntheticKanePack(), DEFAULT_ZIP_LIMITS);

    // #when it is summarized
    const summary = summarizeEvidence(pack);

    // #then method, status and type are kept and the query is dropped
    expect(summary.requests).toEqual([
      {
        method: 'GET',
        url: 'http://127.0.0.1:4100/w/source',
        status: 200,
        mimeType: 'text/html; charset=utf-8',
        startedDateTime: '2026-11-25T17:21:35.764285+00:00',
      },
      {
        method: 'GET',
        url: 'http://127.0.0.1:4100/w/source/export.csv',
        status: 200,
        mimeType: 'text/csv',
        startedDateTime: '2026-11-25T17:21:40.000000+00:00',
      },
    ]);
  });

  it('reports a malformed HAR as a warning instead of throwing', () => {
    // #given a second HAR file that is not JSON
    const pack = parseZip(
      syntheticKanePack([{ name: `${TEST}/logs/1-network.har`, data: '{not json' }]),
      DEFAULT_ZIP_LIMITS,
    );

    // #when it is summarized
    const summary = summarizeEvidence(pack);

    // #then the good HAR is still read and the bad one is named
    expect([
      summary.requests.length,
      summary.warnings.length,
      summary.warnings[0]?.startsWith(`${TEST}/logs/1-network.har`),
    ]).toEqual([2, 1, true]);
  });

  it('returns null for the failed screenshot when every step passed', () => {
    // #given a pack with one passing step
    const pack = parseZip(
      buildZip([
        { name: `${TEST}/steps/1-0-1/screenshot.jpg`, data: 'jpeg' },
        { name: `${TEST}/steps/1-0-1/step.json`, data: '{"status":"passed"}' },
      ]),
      DEFAULT_ZIP_LIMITS,
    );

    // #when it is summarized
    const summary = summarizeEvidence(pack);

    // #then nothing is singled out
    expect(summary.failedStepScreenshot).toBeNull();
  });
});

describe('copyEvidencePack', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-copy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeOriginal(): Promise<{ path: string; bytes: Buffer }> {
    const path = join(dir, 'session', 'a3b683fa.evidence');
    const bytes = syntheticKanePack();
    await mkdir(join(dir, 'session'));
    await writeFile(path, bytes);
    return { path, bytes };
  }

  it('records the sha256 of the bytes it copied', async () => {
    // #given an original pack
    const original = await writeOriginal();

    // #when it is copied
    const copy = await copyEvidencePack(original.path, join(dir, 'run'));

    // #then the recorded hash and length describe both files
    const copied = await readFile(copy.path);
    const expected = createHash('sha256').update(original.bytes).digest('hex');
    expect([copy.sha256, copy.byteLength, copied.equals(original.bytes)]).toEqual([
      expected,
      original.bytes.length,
      true,
    ]);
  });

  it('leaves the original untouched and makes the copy read-only', async () => {
    // #given an original pack and its modification time
    const original = await writeOriginal();
    const before = await stat(original.path);

    // #when it is copied
    const copy = await copyEvidencePack(original.path, join(dir, 'run'));

    // #then the original is unchanged and the copy has no write bits
    const after = await stat(original.path);
    const copyMode = (await stat(copy.path)).mode & 0o777;
    expect([after.mtimeMs === before.mtimeMs, after.mode === before.mode, copyMode]).toEqual([
      true,
      true,
      0o444,
    ]);
  });

  it('refuses to overwrite an existing copy', async () => {
    // #given a pack already copied once
    const original = await writeOriginal();
    await copyEvidencePack(original.path, join(dir, 'run'));

    // #when it is copied again to the same place
    const again = copyEvidencePack(original.path, join(dir, 'run'));

    // #then the second copy fails and leaves no partial file
    await expect(again).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('refuses a symbolic link in place of the pack', async () => {
    // #given a symlink pointing at a real pack
    const original = await writeOriginal();
    const link = join(dir, 'link.evidence');
    await symlink(original.path, link);

    // #when the link is copied
    const copying = copyEvidencePack(link, join(dir, 'run'));

    // #then it is refused
    await expect(copying).rejects.toThrow('not a regular file');
  });
});
