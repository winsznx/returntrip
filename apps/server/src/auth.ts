import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

const SESSION_COOKIE = 'rt_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface Session {
  readonly csrf: string;
  readonly expiresAt: number;
}

/**
 * Local access control for the dashboard. The CLI prints a one-time bootstrap token in a URL
 * fragment (never sent to the server in a URL or logged); the page exchanges it for an HttpOnly,
 * SameSite=Strict session cookie plus a CSRF token required on every mutation.
 */
export class LocalAuth {
  readonly bootstrapToken = randomBytes(24).toString('base64url');
  readonly #sessions = new Map<string, Session>();
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(port: number) {
    this.#allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  }

  /** Rejects DNS-rebinding and cross-site requests before any route runs. */
  checkHostAndOrigin(request: FastifyRequest): string | null {
    const host = request.headers.host ?? '';
    if (!this.#allowedHosts.has(host)) return 'unexpected Host header';
    const origin = request.headers.origin;
    if (origin && !this.#allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return 'cross-origin request';
    return null;
  }

  exchange(token: string, reply: FastifyReply): { csrf: string } | null {
    if (!sameSecret(token, this.bootstrapToken)) return null;
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.#sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    return { csrf };
  }

  #session(request: FastifyRequest): Session | null {
    const cookie = request.headers.cookie ?? '';
    const id = cookie
      .split(';')
      .map((part) => part.trim().split('='))
      .find(([name]) => name === SESSION_COOKIE)?.[1];
    if (!id) return null;
    const session = this.#sessions.get(id);
    if (!session || session.expiresAt < Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  /** Returns an error message when the request may not proceed. */
  authorize(request: FastifyRequest): { status: 401 | 403; message: string } | null {
    const session = this.#session(request);
    if (!session) return { status: 401, message: 'Open the dashboard from the link the CLI printed.' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const csrf = request.headers['x-returntrip-csrf'];
      if (typeof csrf !== 'string' || !sameSecret(csrf, session.csrf)) {
        return { status: 403, message: 'Missing or wrong CSRF token.' };
      }
    }
    return null;
  }
}
