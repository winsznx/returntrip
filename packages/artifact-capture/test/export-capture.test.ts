import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureError } from '../src/capture-error.ts';
import { createCaptureProxy } from '../src/capture-proxy.ts';
import type { CaptureProxy } from '../src/types.ts';
import {
  abortAfterFirstChunk,
  CAPTURE,
  send,
  sha256,
  startUpstream,
  type Upstream,
  type UpstreamHandler,
} from './support/http.ts';

/** RFC 4180 CSV with CRLF line ends, a quoted comma, escaped quotes and multi-byte UTF-8. */
const CSV = Buffer.from(
  'id,vendor,amount,note\r\nP-0001,Acme,12.50,"net 30, prepaid"\r\nP-0002,Café Núñez,87.10,"said ""hola"""\r\nP-0003,東京商事,5.00,\r\n',
  'utf8',
);

let artifactDir = '';
let upstream: Upstream | null = null;
let proxy: CaptureProxy | null = null;

beforeEach(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), 'artifact-capture-'));
});

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = null;
  upstream = null;
  await rm(artifactDir, { recursive: true, force: true });
});

async function setup(handler: UpstreamHandler, maxBytes = CAPTURE.maxBytes): Promise<CaptureProxy> {
  upstream = await startUpstream(handler);
  proxy = await createCaptureProxy({
    upstream: upstream.origin,
    capture: { ...CAPTURE, maxBytes },
    artifactDir,
  });
  return proxy;
}

const serveCsv: UpstreamHandler = (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': CSV.length,
    'content-disposition': 'attachment; filename="payments.csv"',
  });
  res.end(CSV);
};

async function rejectionOf(promise: Promise<unknown>): Promise<CaptureError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CaptureError) return error;
    throw error;
  }
  throw new Error('expected a CaptureError');
}

describe('export capture', () => {
  it('stores the exact bytes of a CSV with CRLF and UTF-8 content', async () => {
    // #given an export expectation for the source workspace
    const capture = await setup(serveCsv);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when the browser downloads the export through the proxy
    const response = await send(capture.origin, '/w/source/export.csv?download=1');
    const artifact = await expectation.wait(2_000);

    // #then browser bytes, stored bytes and the recorded hash all equal the upstream body
    const stored = await readFile(artifact.path);
    expect([response.body.equals(CSV), stored.equals(CSV), artifact.sha256, artifact.byteLength]).toEqual([
      true,
      true,
      sha256(CSV),
      CSV.length,
    ]);
  });

  it('names the artifact by stage and hash and records its metadata', async () => {
    // #given an export expectation
    const capture = await setup(serveCsv);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when the export is downloaded
    await send(capture.origin, '/w/source/export.csv?token=abc');
    const artifact = await expectation.wait(2_000);

    // #then the file name and metadata follow the contract, with the query stripped
    expect({
      ...artifact,
      path: basename(artifact.path),
      requestStartedAt: typeof artifact.requestStartedAt,
    }).toEqual({
      stage: 'export',
      workspace: 'source',
      path: `export-${sha256(CSV).slice(0, 12)}.csv`,
      sha256: sha256(CSV),
      byteLength: CSV.length,
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      contentDisposition: 'attachment; filename="payments.csv"',
      method: 'GET',
      routePath: '/w/source/export.csv',
      requestStartedAt: 'string',
      capturedAt: artifact.capturedAt,
    });
  });

  it('captures a chunked response with no Content-Length', async () => {
    // #given an upstream that streams the CSV in three delayed chunks
    const capture = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.write(CSV.subarray(0, 10));
      setTimeout(() => res.write(CSV.subarray(10, 50)), 20);
      setTimeout(() => res.end(CSV.subarray(50)), 40);
    });
    const expectation = capture.expectExport({ stage: 'reexport', workspace: 'restored' });

    // #when it is downloaded
    await send(capture.origin, '/w/restored/export.csv');
    const artifact = await expectation.wait(2_000);

    // #then the reassembled bytes are exact
    expect((await readFile(artifact.path)).equals(CSV)).toBe(true);
  });

  it('passes HTML pages through untouched and does not treat them as exports', async () => {
    // #given an HTML page served while an expectation is open
    const html = Buffer.from('<!doctype html><title>Café</title><a href="/w/source/export.csv">Export</a>\n');
    const capture = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      res.end(html);
    });
    capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when the page is fetched
    const response = await send(capture.origin, '/w/source');

    // #then the bytes and length are unchanged and the log shows no match
    expect([
      response.body.equals(html),
      response.headers['content-length'],
      capture.requestLog()[0]?.matched,
    ]).toEqual([true, String(html.length), null]);
  });

  it('ignores an export from a different workspace and logs it as unexpected', async () => {
    // #given an expectation for workspace "source"
    const capture = await setup(serveCsv);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when workspace "other" is exported
    await send(capture.origin, '/w/other/export.csv');
    const error = await rejectionOf(expectation.wait(200));

    // #then nothing is captured and the response is flagged
    expect([error.code, capture.requestLog()[0]?.unexpected]).toEqual(['TIMEOUT', true]);
  });

  it('ignores a non-2xx response on the export route', async () => {
    // #given an upstream that fails the export with a CSV-typed 500
    const capture = await setup((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/csv' });
      res.end('error\r\n');
    });
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when it is downloaded
    await send(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(200));

    // #then the expectation is not satisfied
    expect(error.code).toBe('TIMEOUT');
  });

  it('ignores a 206 partial response', async () => {
    // #given an upstream answering with a byte range
    const capture = await setup((_req, res) => {
      res.writeHead(206, { 'content-type': 'text/csv', 'content-range': 'bytes 0-3/100' });
      res.end('id,v');
    });
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when it is downloaded
    await send(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(200));

    // #then a range is never taken for the artifact
    expect(error.code).toBe('TIMEOUT');
  });

  it('ignores the export route when the content type is not allowed', async () => {
    // #given an upstream answering the export route with JSON
    const capture = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"error":"login required"}');
    });
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when it is downloaded
    await send(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(200));

    // #then it is not captured
    expect(error.code).toBe('TIMEOUT');
  });

  it('fails as TOO_LARGE past maxBytes while the browser still gets every byte', async () => {
    // #given a 64-byte limit and a larger CSV
    const capture = await setup(serveCsv, 64);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when it is downloaded
    const response = await send(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(2_000));

    // #then the browser download is intact and the capture is refused
    expect([response.body.equals(CSV), error.code]).toEqual([true, 'TOO_LARGE']);
  });

  it('fails as INCOMPLETE when the browser aborts mid-download', async () => {
    // #given an upstream that sends part of the body and then stalls
    const capture = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-length': 1_000 });
      res.write('id,vendor\r\n');
    });
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when the client drops the connection after the first bytes
    await abortAfterFirstChunk(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(2_000));

    // #then the partial body is not accepted
    expect(error.code).toBe('INCOMPLETE');
  });

  it('fails as INCOMPLETE when the upstream drops the connection mid-body', async () => {
    // #given an upstream that promises 1,000 bytes and resets after 11
    const capture = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-length': 1_000 });
      res.write('id,vendor\r\n', () => res.socket?.destroy());
    });
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when the download is attempted
    await send(capture.origin, '/w/source/export.csv').catch((error: unknown) => error);
    const error = await rejectionOf(expectation.wait(2_000));

    // #then the truncated body is refused
    expect(error.code).toBe('INCOMPLETE');
  });

  it('removes the partial temp file after a refused capture', async () => {
    // #given a capture refused for size
    const capture = await setup(serveCsv, 64);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });
    await send(capture.origin, '/w/source/export.csv');
    await rejectionOf(expectation.wait(2_000));

    // #when the artifact directory settles
    const deadline = Date.now() + 1_000;
    let files = await readdir(artifactDir);
    while (files.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      files = await readdir(artifactDir);
    }

    // #then nothing is left behind
    expect(files).toEqual([]);
  });

  it('fails as AMBIGUOUS when two matching downloads happen in one window', async () => {
    // #given one expectation
    const capture = await setup(serveCsv);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when the export is downloaded twice before the stage ends
    await send(capture.origin, '/w/source/export.csv');
    await send(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(2_000));

    // #then neither download is chosen
    expect(error.code).toBe('AMBIGUOUS');
  });

  it('does not store a matching response when no expectation is open', async () => {
    // #given a proxy with no expectation
    const capture = await setup(serveCsv);

    // #when the export is downloaded
    await send(capture.origin, '/w/source/export.csv');

    // #then it is logged as unexpected and nothing is written
    expect([capture.requestLog()[0], await readdir(artifactDir)]).toEqual([
      expect.objectContaining({ matched: null, unexpected: true, status: 200 }),
      [],
    ]);
  });

  it('refuses an export sent with a Content-Encoding', async () => {
    // #given an upstream that compresses despite being asked for identity
    const capture = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'gzip' });
      res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    });
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when it is downloaded
    await send(capture.origin, '/w/source/export.csv');
    const error = await rejectionOf(expectation.wait(2_000));

    // #then compressed wire bytes are never taken for the CSV
    expect(error.code).toBe('ENCODED');
  });

  it('closes the window once wait settles, so a later download is only logged', async () => {
    // #given a completed capture
    const capture = await setup(serveCsv);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });
    await send(capture.origin, '/w/source/export.csv');
    const artifact = await expectation.wait(2_000);

    // #when the export is downloaded again after the stage ended
    await send(capture.origin, '/w/source/export.csv');

    // #then the first artifact stands and the second response is unexpected
    expect([await expectation.wait(10), capture.requestLog()[1]?.unexpected]).toEqual([artifact, true]);
  });

  it('rejects wait with CANCELED after cancel', async () => {
    // #given an open expectation
    const capture = await setup(serveCsv);
    const expectation = capture.expectExport({ stage: 'export', workspace: 'source' });
    const pending = rejectionOf(expectation.wait(5_000));

    // #when it is canceled
    expectation.cancel();

    // #then the waiter learns why
    expect((await pending).code).toBe('CANCELED');
  });

  it('allows only one open export expectation at a time', async () => {
    // #given an open expectation
    const capture = await setup(serveCsv);
    capture.expectExport({ stage: 'export', workspace: 'source' });

    // #when a second one is armed
    const arm = (): unknown => capture.expectExport({ stage: 'reexport', workspace: 'restored' });

    // #then it is refused
    expect(arm).toThrow('already open');
  });

  it('refuses a stage name that is unsafe in a file name', async () => {
    // #given a proxy
    const capture = await setup(serveCsv);

    // #when a stage containing a path separator is armed
    const arm = (): unknown => capture.expectExport({ stage: '../export', workspace: 'source' });

    // #then it is refused
    expect(arm).toThrow(TypeError);
  });

  it('cancels open expectations when the proxy closes', async () => {
    // #given an expectation being waited on
    const capture = await setup(serveCsv);
    const pending = rejectionOf(capture.expectExport({ stage: 'export', workspace: 'source' }).wait(5_000));

    // #when the proxy closes
    await capture.close();

    // #then the waiter is released
    expect((await pending).code).toBe('CANCELED');
  });
});
