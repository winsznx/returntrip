import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { proxyCaptureDriver } from '@returntrip/orchestrator';
import { RunStore } from '@returntrip/storage';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { httpBrowser, scriptedRepair } from '../../../packages/orchestrator/test/support/http-browser.ts';
import { buildServer, projectId, RunManager } from '../src/index.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', 'examples', 'payment-roundtrip');
const HEALTHY = join(EXAMPLES, 'returntrip.yaml');
const SIGN_FLIP = join(EXAMPLES, 'scenarios', 'sign-flip.yaml');
const PORT = 4777;
const HOST = { host: `127.0.0.1:${PORT}` };

describe('local API', { timeout: 120_000 }, () => {
  let root: string;
  let store: RunStore;
  let runs: RunManager;
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'returntrip-server-'));
    store = await RunStore.open(root);
    const deps = {
      browser: httpBrowser(),
      capture: proxyCaptureDriver(),
      repair: scriptedRepair({ file: 'x', from: 'x', to: 'x', cause: 'unused' }),
    };
    runs = await RunManager.create(store, deps, [HEALTHY, SIGN_FLIP], true);
    const built = await buildServer({ store, runs, port: PORT, version: 'test' });
    app = built.app;
    token = built.auth.bootstrapToken;
  });

  afterEach(async () => {
    await runs.shutdown();
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function session(): Promise<{ cookie: string; csrf: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: HOST,
      payload: { token },
    });
    const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
    return { cookie, csrf: response.json<{ csrf: string }>().csrf };
  }

  async function waitFinished(runId: string, cookie: string): Promise<string> {
    for (let i = 0; i < 600; i += 1) {
      const response = await app.inject({ url: `/api/v1/runs/${runId}`, headers: { ...HOST, cookie } });
      const body = response.json<{ run: { status: string; outcome: string } }>();
      if (body.run.status === 'finished') return body.run.outcome;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('run did not finish');
  }

  it('serves health without a session', async () => {
    // #given no session

    // #when
    const response = await app.inject({ url: '/health', headers: HOST });

    // #then
    expect(response.json()).toEqual({ status: 'ok', version: 'test' });
  });

  it('refuses API calls without a session', async () => {
    // #given no session

    // #when
    const response = await app.inject({ url: '/api/v1/projects', headers: HOST });

    // #then
    expect(response.statusCode).toBe(401);
  });

  it('refuses requests whose Host header is not loopback (DNS rebinding)', async () => {
    // #given
    const { cookie } = await session();

    // #when
    const response = await app.inject({
      url: '/api/v1/projects',
      headers: { host: 'evil.example:4777', cookie },
    });

    // #then
    expect(response.statusCode).toBe(403);
  });

  it('refuses a cross-origin request even with a valid session', async () => {
    // #given
    const { cookie } = await session();

    // #when
    const response = await app.inject({
      url: '/api/v1/projects',
      headers: { ...HOST, cookie, origin: 'https://evil.example' },
    });

    // #then
    expect(response.statusCode).toBe(403);
  });

  it('rejects a wrong bootstrap token', async () => {
    // #given
    const payload = { token: 'not-the-token-at-all' };

    // #when
    const response = await app.inject({ method: 'POST', url: '/api/v1/session', headers: HOST, payload });

    // #then
    expect(response.statusCode).toBe(401);
  });

  it('accepts the bootstrap token only once', async () => {
    // #given the link was already used
    await session();

    // #when it is presented again
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: HOST,
      payload: { token },
    });

    // #then
    expect(again.statusCode).toBe(401);
  });

  it('requires the CSRF token on mutations', async () => {
    // #given
    const { cookie } = await session();

    // #when
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { ...HOST, cookie },
      payload: { projectId: projectId(HEALTHY), mode: 'verify' },
    });

    // #then
    expect(response.statusCode).toBe(403);
  });

  it('lists only the configured projects, by id', async () => {
    // #given
    const { cookie } = await session();

    // #when
    const response = await app.inject({ url: '/api/v1/projects', headers: { ...HOST, cookie } });
    const names = response.json<{ projects: { name: string }[] }>().projects.map((p) => p.name);

    // #then
    expect(names).toEqual(['chicago-payments', 'chicago-sign-flip']);
  });

  it('refuses a repair without a fresh authorization', async () => {
    // #given
    const { cookie, csrf } = await session();
    const sign = runs.projects().find((p) => p.loaded.config.project === 'chicago-sign-flip');

    // #when
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { ...HOST, cookie, 'x-returntrip-csrf': csrf },
      payload: { projectId: sign?.id, mode: 'repair' },
    });

    // #then
    expect(response.statusCode).toBe(403);
  });

  it('starts a verification and streams its events to a finished outcome', async () => {
    // #given
    const { cookie, csrf } = await session();
    const healthy = runs.projects().find((p) => p.loaded.config.project === 'chicago-payments');

    // #when
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { ...HOST, cookie, 'x-returntrip-csrf': csrf, 'idempotency-key': 'k1' },
      payload: { projectId: healthy?.id, mode: 'verify' },
    });
    const runId = started.json<{ runId: string }>().runId;
    const outcome = await waitFinished(runId, cookie);
    const stream = await app.inject({ url: `/api/v1/runs/${runId}/events`, headers: { ...HOST, cookie } });

    // #then
    expect({
      status: started.statusCode,
      outcome,
      lastEvent: stream.body.trim().split('\n\n').at(-1)?.includes('event: run.finished'),
    }).toEqual({ status: 202, outcome: 'VERIFIED', lastEvent: true });
  });

  it('resumes an event stream after Last-Event-ID without repeating events', async () => {
    // #given
    const { cookie, csrf } = await session();
    const healthy = runs.projects().find((p) => p.loaded.config.project === 'chicago-payments');
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { ...HOST, cookie, 'x-returntrip-csrf': csrf },
      payload: { projectId: healthy?.id, mode: 'verify' },
    });
    const runId = started.json<{ runId: string }>().runId;
    await waitFinished(runId, cookie);

    // #when
    const stream = await app.inject({
      url: `/api/v1/runs/${runId}/events`,
      headers: { ...HOST, cookie, 'last-event-id': '3' },
    });
    const ids = [...stream.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));

    // #then
    expect(ids[0]).toBe(4);
  });

  it('returns 404 for an unknown run id', async () => {
    // #given
    const { cookie } = await session();

    // #when
    const response = await app.inject({
      url: '/api/v1/runs/00000000-0000-4000-8000-000000000000',
      headers: { ...HOST, cookie },
    });

    // #then
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});
