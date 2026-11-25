import { mkdir } from 'node:fs/promises';
import {
  type ClientRequest,
  createServer,
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { pipeline, Transform } from 'node:stream';

import type { CaptureConfig } from '@returntrip/contracts';

import { CaptureError } from './capture-error.ts';
import { Expectation } from './expectation.ts';
import {
  compileRoute,
  endToEndHeaders,
  mediaType,
  parseLoopbackOrigin,
  pathWithoutQuery,
  type RouteMatcher,
  rewriteOrigin,
  sanitizeHeaderValue,
} from './http-rules.ts';
import { ExportRecorder, RestoreRecorder } from './recorders.ts';
import type {
  CapturedArtifact,
  CaptureExpectation,
  CaptureProxy,
  ExpectationTarget,
  RequestLogEntry,
  RestoreExpectation,
  RestoreObservation,
} from './types.ts';

export interface CaptureProxyOptions {
  /** Fixed loopback origin every request is forwarded to, such as `http://127.0.0.1:4100`. */
  readonly upstream: string;
  /** Port to bind on 127.0.0.1. 0 or omitted picks a free port. */
  readonly port?: number;
  readonly capture: CaptureConfig;
  /** Private directory for captured artifacts and their temp files. */
  readonly artifactDir: string;
  readonly log?: (entry: RequestLogEntry) => void;
}

const LISTEN_HOST = '127.0.0.1';
const STAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_LOG_ENTRIES = 10_000;
/** Request headers that only make sense between the browser and this proxy. */
const CLIENT_ONLY_REQUEST_HEADERS = ['expect'];

interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly startedAt: number;
  matched: 'export' | 'restore' | null;
  unexpected: boolean;
  bytesOut: number;
}

/**
 * Starts a reverse proxy on 127.0.0.1 in front of one fixed loopback upstream. Every response
 * streams through unmodified; while an expectation is open, the matching export response is
 * also written to `artifactDir` and hashed, and the matching restore upload is hashed.
 */
export async function createCaptureProxy(options: CaptureProxyOptions): Promise<CaptureProxy> {
  const upstream = parseLoopbackOrigin(options.upstream);
  const { capture } = options;
  if (!Number.isInteger(capture.maxBytes) || capture.maxBytes < 1) {
    throw new RangeError(`capture.maxBytes must be a positive integer, got ${capture.maxBytes}`);
  }
  const exportRoute = compileRoute(capture.route);
  const restoreRoute = capture.restoreRoute ? compileRoute(capture.restoreRoute) : null;
  await mkdir(options.artifactDir, { recursive: true, mode: 0o700 });

  const proxy = new LoopbackCaptureProxy(upstream, options, exportRoute, restoreRoute);
  await proxy.listen(options.port ?? 0);
  return proxy;
}

class LoopbackCaptureProxy implements CaptureProxy {
  readonly #upstream: URL;
  readonly #options: CaptureProxyOptions;
  readonly #exportRoute: RouteMatcher;
  readonly #restoreRoute: RouteMatcher | null;
  readonly #exportTypes: ReadonlySet<string>;
  readonly #agent: HttpAgent;
  readonly #server: Server;
  readonly #entries: RequestLogEntry[] = [];
  #origin = '';
  #export: Expectation<CapturedArtifact> | null = null;
  #restore: Expectation<RestoreObservation> | null = null;
  #closed = false;

  constructor(
    upstream: URL,
    options: CaptureProxyOptions,
    exportRoute: RouteMatcher,
    restoreRoute: RouteMatcher | null,
  ) {
    this.#upstream = upstream;
    this.#options = options;
    this.#exportRoute = exportRoute;
    this.#restoreRoute = restoreRoute;
    this.#exportTypes = new Set(
      options.capture.contentTypes
        .map((type) => mediaType(type))
        .filter((type): type is string => type !== null),
    );
    this.#agent =
      upstream.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: true })
        : new HttpAgent({ keepAlive: true });
    this.#server = createServer((req, res) => this.#handle(req, res));
    this.#server.on('upgrade', (req: IncomingMessage, socket: Duplex) => this.#refuseUpgrade(req, socket));
  }

  get origin(): string {
    return this.#origin;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, LISTEN_HOST, () => {
        this.#server.off('error', reject);
        const address = this.#server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('capture proxy did not bind a TCP port'));
          return;
        }
        this.#origin = `http://${LISTEN_HOST}:${address.port}`;
        resolve();
      });
    });
  }

  expectExport(target: ExpectationTarget): CaptureExpectation {
    this.#assertCanArm(target, this.#export, 'export');
    const expectation: Expectation<CapturedArtifact> = new Expectation(target.stage, target.workspace, () => {
      if (this.#export === expectation) this.#export = null;
    });
    this.#export = expectation;
    return expectation;
  }

  expectRestore(target: ExpectationTarget): RestoreExpectation {
    if (!this.#restoreRoute) throw new Error('capture.restoreRoute is not configured');
    this.#assertCanArm(target, this.#restore, 'restore');
    const expectation: Expectation<RestoreObservation> = new Expectation(
      target.stage,
      target.workspace,
      () => {
        if (this.#restore === expectation) this.#restore = null;
      },
    );
    this.#restore = expectation;
    return expectation;
  }

  requestLog(): readonly RequestLogEntry[] {
    return [...this.#entries];
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#export?.cancel();
    this.#restore?.cancel();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
    this.#agent.destroy();
  }

  #assertCanArm(
    target: ExpectationTarget,
    current: { readonly isOpen: boolean; readonly stage: string } | null,
    kind: string,
  ): void {
    if (this.#closed) throw new Error('capture proxy is closed');
    if (!STAGE_PATTERN.test(target.stage))
      throw new TypeError(`invalid stage name ${JSON.stringify(target.stage)}`);
    if (target.workspace === '' || target.workspace.includes('/')) {
      throw new TypeError(`invalid workspace ${JSON.stringify(target.workspace)}`);
    }
    if (current?.isOpen) throw new Error(`an ${kind} expectation for stage ${current.stage} is already open`);
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const target = req.url ?? '';
    const context: RequestContext = {
      method: req.method ?? 'GET',
      path: pathWithoutQuery(target),
      startedAt: Date.now(),
      matched: null,
      unexpected: false,
      bytesOut: 0,
    };
    res.once('close', () => this.#record(context, res.statusCode));

    // Absolute-form targets (`GET http://other/`) would name a different host: refuse them.
    if (!target.startsWith('/')) {
      req.resume();
      respondPlain(res, 400, 'Bad request: only origin-form request targets are accepted\n');
      return;
    }

    const restore = this.#matchRestore(req, context);
    const upstreamRequest = this.#forward(req, target);
    upstreamRequest.once('response', (upstreamResponse) => {
      restore?.responded(upstreamResponse.statusCode ?? 502);
      this.#relayResponse(context, upstreamResponse, res);
    });
    upstreamRequest.once('error', (error) => {
      restore?.upstreamFailed(error);
      if (!res.headersSent && !res.destroyed) respondPlain(res, 502, 'Bad gateway: upstream unavailable\n');
      else res.destroy();
    });

    const onBodyDone = (error: Error | null | undefined): void => {
      restore?.bodyFinished(error ?? null);
    };
    if (restore) {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          restore.accept(chunk);
          callback(null, chunk);
        },
      });
      pipeline(req, meter, upstreamRequest, onBodyDone);
    } else {
      pipeline(req, upstreamRequest, onBodyDone);
    }
  }

  #forward(req: IncomingMessage, target: string): ClientRequest {
    const headers = endToEndHeaders(req.headers);
    for (const name of CLIENT_ONLY_REQUEST_HEADERS) delete headers[name];
    headers.host = this.#upstream.host;
    // Identity encoding keeps the captured bytes equal to the file the browser downloads.
    headers['accept-encoding'] = 'identity';
    for (const name of ['origin', 'referer']) {
      const value = headers[name];
      if (typeof value === 'string')
        headers[name] = rewriteOrigin(value, this.#origin, this.#upstream.origin);
    }
    const options: RequestOptions = {
      protocol: this.#upstream.protocol,
      hostname: this.#upstream.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: this.#upstream.port,
      method: req.method,
      path: target,
      headers,
      agent: this.#agent,
    };
    return this.#upstream.protocol === 'https:' ? httpsRequest(options) : httpRequest(options);
  }

  #relayResponse(context: RequestContext, upstreamResponse: IncomingMessage, res: ServerResponse): void {
    const status = upstreamResponse.statusCode ?? 502;
    const headers = endToEndHeaders(upstreamResponse.headers);
    const location = headers.location;
    if (typeof location === 'string') {
      headers.location = rewriteOrigin(location, this.#upstream.origin, this.#origin);
    }

    const recorder = this.#matchExport(context, status, upstreamResponse.headers);
    res.writeHead(status, headers);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        context.bytesOut += chunk.length;
        const written = recorder?.accept(chunk);
        if (written) written.then(() => callback(null, chunk), callback);
        else callback(null, chunk);
      },
    });
    pipeline(upstreamResponse, meter, res, (error) => {
      recorder?.finish(error ?? null, upstreamResponse.complete);
    });
  }

  #matchExport(context: RequestContext, status: number, headers: IncomingHttpHeaders): ExportRecorder | null {
    const { capture } = this.#options;
    if (context.method !== capture.method) return null;
    const workspace = this.#exportRoute(context.path);
    if (workspace === null) return null;
    // 206 is a byte range, never the whole artifact.
    if (status < 200 || status > 299 || status === 206) return null;
    const contentType = mediaType(headers['content-type']);
    if (contentType === null || !this.#exportTypes.has(contentType)) return null;

    const expectation = this.#export;
    if (
      !expectation?.isOpen ||
      expectation.workspace !== workspace ||
      context.startedAt < expectation.armedAt
    ) {
      context.unexpected = true;
      return null;
    }
    context.matched = 'export';

    let recorder: ExportRecorder | null = null;
    if (!expectation.claim(() => recorder?.abort())) return null;
    const encoding = headers['content-encoding']?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      expectation.fail(
        new CaptureError(
          'ENCODED',
          `export for stage ${expectation.stage} arrived with Content-Encoding ${encoding}`,
        ),
      );
      return null;
    }
    const declaredLength = headers['content-length'];
    recorder = new ExportRecorder(expectation, this.#options.artifactDir, capture.maxBytes, {
      status,
      contentType: headers['content-type'] ?? null,
      contentDisposition: sanitizeHeaderValue(headers['content-disposition']),
      method: context.method,
      routePath: context.path,
      requestStartedAt: new Date(context.startedAt).toISOString(),
      contentLength: declaredLength === undefined ? null : Number(declaredLength),
    });
    return recorder;
  }

  #matchRestore(req: IncomingMessage, context: RequestContext): RestoreRecorder | null {
    const { capture } = this.#options;
    if (!this.#restoreRoute || context.method !== capture.restoreMethod) return null;
    const workspace = this.#restoreRoute(context.path);
    if (workspace === null) return null;

    const expectation = this.#restore;
    if (
      !expectation?.isOpen ||
      expectation.workspace !== workspace ||
      context.startedAt < expectation.armedAt
    ) {
      context.unexpected = true;
      return null;
    }
    context.matched = 'restore';

    let recorder: RestoreRecorder | null = null;
    if (!expectation.claim(() => recorder?.abort())) return null;
    recorder = new RestoreRecorder(expectation, capture.maxBytes, capture.restoreFileField, {
      method: context.method,
      routePath: context.path,
      contentType: req.headers['content-type'],
    });
    return recorder;
  }

  #refuseUpgrade(req: IncomingMessage, socket: Duplex): void {
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    this.#record(
      {
        method: req.method ?? 'GET',
        path: pathWithoutQuery(req.url ?? ''),
        startedAt: Date.now(),
        matched: null,
        unexpected: false,
        bytesOut: 0,
      },
      501,
    );
  }

  #record(context: RequestContext, status: number): void {
    const entry: RequestLogEntry = {
      at: new Date(context.startedAt).toISOString(),
      method: context.method,
      path: context.path,
      status,
      durationMs: Date.now() - context.startedAt,
      bytesOut: context.bytesOut,
      matched: context.matched,
      ...(context.unexpected ? { unexpected: true } : {}),
    };
    this.#entries.push(entry);
    if (this.#entries.length > MAX_LOG_ENTRIES) this.#entries.shift();
    try {
      this.#options.log?.(entry);
    } catch (error) {
      process.emitWarning(
        `capture proxy log callback threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function respondPlain(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
  });
  res.end(message);
}
