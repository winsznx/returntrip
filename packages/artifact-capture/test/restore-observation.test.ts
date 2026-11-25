import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureError } from '../src/capture-error.ts';
import { createCaptureProxy } from '../src/capture-proxy.ts';
import type { CaptureProxy } from '../src/types.ts';
import { CAPTURE, send, sha256, startUpstream, type Upstream } from './support/http.ts';

const UPLOAD = Buffer.from(
  'id,vendor,amount\r\nP-0002,Café Núñez,87.10\r\nP-0003,"Smith, Jones",1.00\r\n',
  'utf8',
);

let artifactDir = '';
let upstream: Upstream | null = null;
let proxy: CaptureProxy | null = null;

beforeEach(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), 'artifact-restore-'));
  upstream = await startUpstream((_req, res) => {
    res.writeHead(303, { location: '/w/restored?flash=ok', 'content-length': 0 });
    res.end();
  });
});

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = null;
  upstream = null;
  await rm(artifactDir, { recursive: true, force: true });
});

async function start(maxBytes = CAPTURE.maxBytes): Promise<CaptureProxy> {
  if (!upstream) throw new Error('upstream not started');
  proxy = await createCaptureProxy({
    upstream: upstream.origin,
    capture: { ...CAPTURE, maxBytes },
    artifactDir,
  });
  return proxy;
}

/** Serializes a form the way a browser would, using the platform's multipart encoder. */
async function multipart(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const encoded = new Request('http://form.invalid/', { method: 'POST', body: form });
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    contentType: encoded.headers.get('content-type') ?? '',
  };
}

function uploadForm(field = 'file'): FormData {
  const form = new FormData();
  form.append('mode', 'replace');
  form.append(field, new File([UPLOAD], 'payments.csv', { type: 'text/csv' }));
  return form;
}

async function rejectionOf(promise: Promise<unknown>): Promise<CaptureError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CaptureError) return error;
    throw error;
  }
  throw new Error('expected a CaptureError');
}

describe('restore observation', () => {
  it('hashes the uploaded file part to the sha256 of the original file', async () => {
    // #given a restore expectation and a browser-style multipart upload
    const capture = await start();
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });
    const { body, contentType } = await multipart(uploadForm());

    // #when the upload goes through the proxy
    await send(capture.origin, '/w/restored/import', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    const observation = await expectation.wait(2_000);

    // #then the file is identified by its exact bytes
    expect(observation).toMatchObject({
      sha256: sha256(UPLOAD),
      byteLength: UPLOAD.length,
      fileName: 'payments.csv',
      contentType: 'text/csv',
      wholeBody: false,
      responseStatus: 303,
      routePath: '/w/restored/import',
    });
  });

  it('forwards the upload to the upstream unchanged', async () => {
    // #given a restore expectation
    const capture = await start();
    capture.expectRestore({ stage: 'restore', workspace: 'restored' });
    const { body, contentType } = await multipart(uploadForm());

    // #when the upload goes through the proxy
    await send(capture.origin, '/w/restored/import', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });

    // #then the upstream received the identical body
    expect(upstream?.received[0]?.body.equals(body)).toBe(true);
  });

  it('hashes the whole body when the upload is not multipart', async () => {
    // #given a raw CSV body
    const capture = await start();
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });

    // #when it is posted
    await send(capture.origin, '/w/restored/import', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: UPLOAD,
    });
    const observation = await expectation.wait(2_000);

    // #then the body itself is the file
    expect([observation.wholeBody, observation.sha256, observation.fileName]).toEqual([
      true,
      sha256(UPLOAD),
      null,
    ]);
  });

  it('fails as NO_FILE when the configured field holds no file', async () => {
    // #given a multipart form with the file under a different field
    const capture = await start();
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });
    const { body, contentType } = await multipart(uploadForm('attachment'));

    // #when it is posted
    await send(capture.origin, '/w/restored/import', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    const error = await rejectionOf(expectation.wait(2_000));

    // #then the missing file is reported
    expect(error.code).toBe('NO_FILE');
  });

  it('fails as MALFORMED for a multipart body that cannot be parsed', async () => {
    // #given a body that claims to be multipart but has no valid parts
    const capture = await start();
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });

    // #when it is posted
    await send(capture.origin, '/w/restored/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      body: Buffer.from('this is not multipart'),
    });
    const error = await rejectionOf(expectation.wait(2_000));

    // #then it is refused
    expect(error.code).toBe('MALFORMED');
  });

  it('fails as TOO_LARGE past maxBytes but still delivers the upload', async () => {
    // #given a 32-byte limit
    const capture = await start(32);
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });

    // #when a larger body is posted
    await send(capture.origin, '/w/restored/import', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: UPLOAD,
    });
    const error = await rejectionOf(expectation.wait(2_000));

    // #then the upstream got the bytes and the observation is refused
    expect([upstream?.received[0]?.body.equals(UPLOAD), error.code]).toEqual([true, 'TOO_LARGE']);
  });

  it('fails as AMBIGUOUS when two uploads happen in one window', async () => {
    // #given one restore expectation
    const capture = await start();
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });
    const post = (): Promise<unknown> =>
      send(capture.origin, '/w/restored/import', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: UPLOAD,
      });

    // #when the file is uploaded twice
    await post();
    await post();
    const error = await rejectionOf(expectation.wait(2_000));

    // #then neither upload is chosen
    expect(error.code).toBe('AMBIGUOUS');
  });

  it('ignores uploads to another workspace', async () => {
    // #given an expectation for workspace "restored"
    const capture = await start();
    const expectation = capture.expectRestore({ stage: 'restore', workspace: 'restored' });

    // #when the source workspace receives an upload
    await send(capture.origin, '/w/source/import', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: UPLOAD,
    });
    const error = await rejectionOf(expectation.wait(200));

    // #then the expectation is not satisfied
    expect([error.code, capture.requestLog()[0]?.unexpected]).toEqual(['TIMEOUT', true]);
  });

  it('refuses expectRestore when no restore route is configured', async () => {
    // #given a proxy whose config has no restoreRoute
    if (!upstream) throw new Error('upstream not started');
    const { restoreRoute: _omitted, ...withoutRestore } = CAPTURE;
    proxy = await createCaptureProxy({ upstream: upstream.origin, capture: withoutRestore, artifactDir });
    const capture = proxy;

    // #when a restore expectation is armed
    const arm = (): unknown => capture.expectRestore({ stage: 'restore', workspace: 'restored' });

    // #then it is refused
    expect(arm).toThrow('restoreRoute');
  });
});
