import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCaptureProxy } from '../src/capture-proxy.ts';
import type { CaptureProxy } from '../src/types.ts';
import { CAPTURE, send, startUpstream, type Upstream, type UpstreamHandler } from './support/http.ts';

let artifactDir = '';
let upstream: Upstream | null = null;
let proxy: CaptureProxy | null = null;

beforeEach(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), 'artifact-forward-'));
});

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = null;
  upstream = null;
  await rm(artifactDir, { recursive: true, force: true });
});

async function setup(handler: UpstreamHandler): Promise<{ capture: CaptureProxy; target: Upstream }> {
  const target = await startUpstream(handler);
  upstream = target;
  proxy = await createCaptureProxy({ upstream: target.origin, capture: CAPTURE, artifactDir });
  return { capture: proxy, target };
}

const ok: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
};

describe('forwarding', () => {
  it('binds the proxy to 127.0.0.1 only', async () => {
    // #given a running proxy
    const { capture } = await setup(ok);

    // #when its origin is inspected
    const { hostname } = new URL(capture.origin);

    // #then it is the IPv4 loopback address
    expect(hostname).toBe('127.0.0.1');
  });

  it('rewrites Location headers from the upstream origin to the proxy origin', async () => {
    // #given an upstream that redirects using its own absolute origin
    let origin = '';
    const { capture } = await setup((_req, res) => {
      res.writeHead(302, { location: `${origin}/w/restored?flash=done` });
      res.end();
    });
    origin = upstream?.origin ?? '';

    // #when a request is redirected
    const response = await send(capture.origin, '/w/restored/import');

    // #then the browser is sent back through the proxy
    expect(response.headers.location).toBe(`${capture.origin}/w/restored?flash=done`);
  });

  it('leaves a redirect to another origin alone', async () => {
    // #given an upstream redirecting off-site
    const { capture } = await setup((_req, res) => {
      res.writeHead(302, { location: 'https://example.com/login' });
      res.end();
    });

    // #when a request is redirected
    const response = await send(capture.origin, '/');

    // #then the proxy does not follow or rewrite it
    expect([response.status, response.headers.location]).toEqual([302, 'https://example.com/login']);
  });

  it('sends a request with a foreign Host header only to the fixed upstream', async () => {
    // #given a client that claims to be talking to another host
    const { capture, target } = await setup(ok);

    // #when it sends Host: evil.example
    const response = await send(capture.origin, '/w/source', { headers: { host: 'evil.example:80' } });

    // #then the fixed upstream answered, with its own Host restored
    expect([response.body.toString(), target.received[0]?.headers.host]).toEqual([
      'ok',
      new URL(target.origin).host,
    ]);
  });

  it('refuses absolute-form request targets instead of proxying to them', async () => {
    // #given a client using the proxy as a forward proxy
    const { capture, target } = await setup(ok);

    // #when it asks for an absolute URL
    const response = await send(capture.origin, 'http://evil.example/steal');

    // #then the request is refused and never reaches any upstream
    expect([response.status, target.received.length]).toEqual([400, 0]);
  });

  it('never asks the upstream for a compressed body', async () => {
    // #given a browser that accepts gzip and brotli
    const { capture, target } = await setup(ok);

    // #when it makes a request
    await send(capture.origin, '/w/source/export.csv', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });

    // #then the upstream is asked for identity encoding only
    expect(target.received[0]?.headers['accept-encoding']).toBe('identity');
  });

  it('passes cookies both ways without writing them to the request log', async () => {
    // #given an upstream that echoes the cookie and sets a new one
    const { capture, target } = await setup((req, res) => {
      res.writeHead(200, { 'set-cookie': 'session=server-secret; HttpOnly', 'content-type': 'text/plain' });
      res.end(req.headers.cookie ?? '');
    });

    // #when a request carries a cookie
    const response = await send(capture.origin, '/w/source', {
      headers: { cookie: 'session=client-secret' },
    });

    // #then both cookies arrive and neither appears in the log
    const log = JSON.stringify(capture.requestLog());
    expect([
      target.received[0]?.headers.cookie,
      response.headers['set-cookie'],
      log.includes('secret'),
    ]).toEqual(['session=client-secret', ['session=server-secret; HttpOnly'], false]);
  });

  it('drops hop-by-hop headers named by Connection', async () => {
    // #given a request with a custom hop-by-hop header
    const { capture, target } = await setup(ok);

    // #when it is forwarded
    await send(capture.origin, '/', { headers: { connection: 'x-hop', 'x-hop': '1', 'x-end': '2' } });

    // #then only the end-to-end header reaches the upstream
    expect([target.received[0]?.headers['x-hop'], target.received[0]?.headers['x-end']]).toEqual([
      undefined,
      '2',
    ]);
  });

  it('rewrites the Origin header so upstream same-origin checks still pass', async () => {
    // #given a form post whose Origin is the proxy
    const { capture, target } = await setup(ok);

    // #when it is forwarded
    await send(capture.origin, '/w/x/import', { method: 'POST', headers: { origin: capture.origin } });

    // #then the upstream sees its own origin
    expect(target.received[0]?.headers.origin).toBe(target.origin);
  });

  it('answers 502 with a plain message when the upstream is down', async () => {
    // #given a proxy whose upstream has stopped
    const { capture, target } = await setup(ok);
    await target.close();

    // #when a request is made
    const response = await send(capture.origin, '/');

    // #then the failure is explicit
    expect([response.status, response.body.toString()]).toEqual([502, 'Bad gateway: upstream unavailable\n']);
  });

  it('logs path without query, status, size and timing for each request', async () => {
    // #given a proxy and a log listener
    const seen: unknown[] = [];
    const target = await startUpstream(ok);
    upstream = target;
    proxy = await createCaptureProxy({
      upstream: target.origin,
      capture: CAPTURE,
      artifactDir,
      log: (e) => seen.push(e),
    });

    // #when one request is made
    await send(proxy.origin, '/w/source?token=abc');
    await new Promise((resolve) => setImmediate(resolve));

    // #then the listener and requestLog agree on a query-free entry
    expect([seen, proxy.requestLog()]).toEqual([
      [
        expect.objectContaining({
          method: 'GET',
          path: '/w/source',
          status: 200,
          bytesOut: 2,
          matched: null,
        }),
      ],
      seen,
    ]);
  });
});

describe('createCaptureProxy validation', () => {
  it.each([
    'http://10.0.0.5:4100',
    'http://example.com',
    'http://127.0.0.1:4100/app',
    'http://user:pass@127.0.0.1:4100',
    'ftp://127.0.0.1:21',
  ])('refuses the upstream %s', async (bad) => {
    // #given an upstream that is not a bare loopback origin
    const options = { upstream: bad, capture: CAPTURE, artifactDir };

    // #when the proxy is created
    const creating = createCaptureProxy(options);

    // #then it is refused before binding
    await expect(creating).rejects.toThrow(TypeError);
  });

  it('accepts localhost with a trailing slash', async () => {
    // #given a localhost upstream written with a slash
    const options = { upstream: 'http://localhost:4100/', capture: CAPTURE, artifactDir };

    // #when the proxy is created
    proxy = await createCaptureProxy(options);

    // #then it listens
    expect(proxy.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
