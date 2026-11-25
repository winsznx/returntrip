import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CaptureConfig } from '@returntrip/contracts';

export const CAPTURE: CaptureConfig = {
  mode: 'responseProxy',
  route: '/w/:workspace/export.csv',
  method: 'GET',
  contentTypes: ['text/csv'],
  maxBytes: 1024 * 1024,
  restoreRoute: '/w/:workspace/import',
  restoreMethod: 'POST',
  restoreFileField: 'file',
  duplicates: 'reject',
};

export interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

export interface Upstream {
  readonly origin: string;
  readonly received: ReceivedRequest[];
  close(): Promise<void>;
}

/** A real HTTP server on an ephemeral loopback port that records every request it sees. */
export async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface ClientResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** Plain http client, so no Accept-Encoding or decompression is added behind the test's back. */
export function send(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Starts a download and drops the connection as soon as the first body bytes arrive. */
export function abortAfterFirstChunk(origin: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = request({ hostname: url.hostname, port: url.port, path }, (res) => {
      res.once('data', (chunk: Buffer) => {
        req.destroy();
        resolve(chunk.length);
      });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
