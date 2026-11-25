import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { COMPARISON_EDGES, DIFFERENCE_KINDS, type RunEvent } from '@returntrip/contracts';
import { OUTCOME_TEXT, scenarioOf } from '@returntrip/orchestrator';
import { buildRunReport, renderMarkdown } from '@returntrip/reporting';
import type { RunStore } from '@returntrip/storage';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LocalAuth } from './auth.ts';
import type { RunManager } from './run-manager.ts';

const UUID = z.string().uuid();
const HEARTBEAT_MS = 15_000;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  readonly store: RunStore;
  readonly runs: RunManager;
  readonly port: number;
  readonly version: string;
  /** Built dashboard (apps/dashboard/dist). Optional so the API can run alone in tests. */
  readonly staticDir?: string;
}

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  retryable = false,
): FastifyReply {
  return reply.status(status).send({ error: { code, message, retryable, requestId: reply.request.id } });
}

function parseOr400<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  void reply.status(400).send({
    error: {
      code: 'VALIDATION',
      message: 'Request is not valid.',
      fieldIssues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      retryable: false,
      requestId: reply.request.id,
    },
  });
  return null;
}

/** Builds the loopback API. All execution goes through the same engine and store as the CLI. */
export async function buildServer(
  options: ServerOptions,
): Promise<{ app: FastifyInstance; auth: LocalAuth }> {
  const { store, runs } = options;
  const auth = new LocalAuth(options.port);
  const app = Fastify({ bodyLimit: 64 * 1024, logger: false, genReqId: () => randomUUID() });

  app.addHook('onRequest', async (request, reply) => {
    const problem = auth.checkHostAndOrigin(request);
    if (problem) return fail(reply, 403, 'FORBIDDEN', problem);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/v1/') && request.url !== '/api/v1/session') {
      const denied = auth.authorize(request);
      if (denied)
        return fail(
          reply,
          denied.status,
          denied.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          denied.message,
        );
    }
    return undefined;
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return fail(
      reply,
      status,
      status === 413 ? 'TOO_LARGE' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL',
      status < 500 ? error.message : 'Internal error.',
    );
  });

  app.get('/health', async () => ({ status: 'ok', version: options.version }));

  app.post('/api/v1/session', async (request, reply) => {
    const body = parseOr400(z.object({ token: z.string().min(10).max(200) }), request.body, reply);
    if (!body) return reply;
    const session = auth.exchange(body.token, reply);
    if (!session) return fail(reply, 401, 'UNAUTHORIZED', 'That link has expired. Run returntrip ui again.');
    return session;
  });

  app.get('/api/v1/projects', async () => ({
    projects: runs.projects().map((project) => {
      const { config } = project.loaded;
      const app = config.application;
      return {
        id: project.id,
        name: config.project,
        configPath: project.loaded.configPath,
        mode: app.mode,
        repairEnabled: config.repair.enabled && app.mode === 'managed',
        scenario: scenarioOf(project.loaded),
        sourceRows: null,
        sourceSha256: config.source.sha256,
        fields: config.contract.fields.map((field) => ({ name: field.name, type: field.type })),
        identity: config.contract.identity.mode,
        limits: config.limits,
        repairPaths: app.mode === 'managed' ? app.repairPaths : [],
        activeRunId: runs.activeFor(project.id),
      };
    }),
  }));

  app.post('/api/v1/projects/:id/validate', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const project = await runs.revalidate(id);
      return { ok: true, configHash: project.loaded.configHash };
    } catch (error) {
      return reply
        .status(200)
        .send({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/v1/projects/:id/repair-authorization', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = runs.project(id);
    if (!project) return fail(reply, 404, 'NOT_FOUND', 'Unknown project.');
    if (!project.loaded.config.repair.enabled)
      return fail(reply, 403, 'REPAIR_DISABLED', 'Repair is not enabled in this config.');
    return { authorization: runs.authorizeRepair(id), expiresInSeconds: 600 };
  });

  app.post('/api/v1/runs', async (request, reply) => {
    const body = parseOr400(
      z.object({
        projectId: z.string().regex(/^[0-9a-f]{12}$/),
        mode: z.enum(['verify', 'repair']),
        authorization: z.string().max(100).optional(),
        fromRunId: UUID.optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return reply;
    const key = request.headers['idempotency-key'];
    const started = await runs.start({
      ...body,
      ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
    });
    if ('error' in started) return fail(reply, started.status, 'RUN_REFUSED', started.error);
    return reply.status(202).send({ runId: started.run.id, status: started.run.status });
  });

  app.get('/api/v1/runs', async (request, reply) => {
    const query = parseOr400(
      z.object({
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      request.query,
      reply,
    );
    if (!query) return reply;
    return store.listRuns({ ...(query.limit ? { limit: query.limit } : {}), cursor: query.cursor ?? null });
  });

  const runOr404 = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const id = UUID.safeParse((request.params as { id?: unknown }).id);
    if (!id.success || !store.getRun(id.data)) {
      void fail(reply, 404, 'NOT_FOUND', 'Unknown run.');
      return null;
    }
    return id.data;
  };

  app.get('/api/v1/runs/:id', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const run = store.getRun(id);
    const project = runs.projects().find((p) => p.loaded.configPath === run?.configPath);
    return {
      run,
      outcomeText: run?.outcome ? OUTCOME_TEXT[run.outcome] : null,
      active: runs.isActive(id),
      report: buildRunReport(store, id, project ? scenarioOf(project.loaded) : null),
    };
  });

  app.get('/api/v1/runs/:id/differences', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const query = parseOr400(
      z.object({
        attempt: z.coerce.number().int().min(1),
        edge: z.enum(COMPARISON_EDGES),
        kind: z.enum(DIFFERENCE_KINDS).optional(),
        field: z.string().max(128).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      request.query,
      reply,
    );
    if (!query) return reply;
    return store.listDifferences(id, query);
  });

  app.get('/api/v1/runs/:id/artifacts', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    return { artifacts: store.listArtifacts(id).map(({ provenance: _provenance, ...rest }) => rest) };
  });

  app.get('/api/v1/runs/:id/artifacts/:artifactId', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const artifactId = UUID.safeParse((request.params as { artifactId?: unknown }).artifactId);
    const artifact = artifactId.success ? store.getArtifact(id, artifactId.data) : null;
    if (!artifact) return fail(reply, 404, 'NOT_FOUND', 'Unknown artifact.');
    const bytes = await store.readArtifact(artifact);
    const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? 'artifact';
    return reply
      .header(
        'content-type',
        artifact.mediaType.startsWith('text/') ? `${artifact.mediaType}; charset=utf-8` : artifact.mediaType,
      )
      .header('content-disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .header('x-artifact-sha256', artifact.sha256)
      .send(bytes);
  });

  app.get('/api/v1/runs/:id/report', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const format = (request.query as { format?: string }).format;
    const report = buildRunReport(store, id);
    if (format === 'markdown')
      return reply.header('content-type', 'text/markdown; charset=utf-8').send(renderMarkdown(report));
    return report;
  });

  app.post('/api/v1/runs/:id/cancel', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const canceled = runs.cancel(id);
    return reply.status(202).send({ canceling: canceled, status: store.getRun(id)?.status });
  });

  app.post('/api/v1/runs/:id/replay', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const previous = store.getRun(id);
    const project = runs.projects().find((p) => p.loaded.configPath === previous?.configPath);
    if (!previous || !project)
      return fail(reply, 404, 'NOT_FOUND', 'The config for this run is not loaded in this dashboard.');
    if (project.loaded.configHash !== previous.configHash) {
      return fail(
        reply,
        409,
        'CONFIG_CHANGED',
        'The config changed since this run, so it cannot be replayed as is.',
      );
    }
    if (previous.mode === 'repair') {
      return fail(reply, 409, 'USE_REPAIR', 'Start a repair from the project, which asks for consent first.');
    }
    const started = await runs.start({ projectId: project.id, mode: 'verify', fromRunId: id });
    if ('error' in started) return fail(reply, started.status, 'RUN_REFUSED', started.error);
    return reply.status(202).send({ runId: started.run.id });
  });

  app.delete('/api/v1/runs/:id', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    if (runs.isActive(id)) return fail(reply, 409, 'ACTIVE', 'Cancel the run before deleting it.');
    await store.deleteRun(id);
    return reply.status(204).send();
  });

  app.get('/api/v1/runs/:id/events', async (request, reply) => {
    const id = runOr404(request, reply);
    if (!id) return reply;
    const lastEventId = Number(
      request.headers['last-event-id'] ?? (request.query as { after?: string }).after ?? -1,
    );
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let lastSent = Number.isFinite(lastEventId) ? lastEventId : -1;
    const send = (event: RunEvent): void => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'run.finished') raw.end();
    };
    // Subscribe first, then replay from the store, so nothing emitted in between is lost.
    const buffered: RunEvent[] = [];
    let replaying = true;
    const unsubscribe = store.subscribe(id, (event) => (replaying ? buffered.push(event) : send(event)));
    for (const event of store.listEvents(id, lastSent)) send(event);
    replaying = false;
    for (const event of buffered) send(event);
    if (store.getRun(id)?.status === 'finished' && !raw.writableEnded) raw.end();
    const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
    raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  if (options.staticDir) {
    const root = options.staticDir;
    app.get('/*', async (request, reply) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
      const candidate = normalize(join(root, pathname));
      const inside = candidate === root || candidate.startsWith(`${root}${sep}`);
      const file =
        inside &&
        (await stat(candidate).then(
          (s) => s.isFile(),
          () => false,
        ))
          ? candidate
          : join(root, 'index.html');
      const body = await readFile(file);
      reply.header('content-type', MEDIA_TYPES[extname(file)] ?? 'application/octet-stream');
      reply.header(
        'content-security-policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      if (file.includes(`${sep}assets${sep}`))
        reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(body);
    });
  }

  return { app, auth };
}
