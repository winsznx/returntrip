import type { DifferencePage, ProjectSummary, RunDetail, RunPage } from './types.ts';

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly fieldIssues?: readonly { readonly path: string; readonly message: string }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** The session is missing, expired, or this tab never received the CSRF token. */
  get needsLink(): boolean {
    return this.status === 401 || (this.status === 403 && /csrf/i.test(this.body.message));
  }
}

export const RELAUNCH_MESSAGE = 'Open the link printed by `returntrip ui`.';

/** Held in memory only: a reload drops it, and the printed link restores it. */
let csrfToken: string | null = null;

export function hasCsrf(): boolean {
  return csrfToken !== null;
}

function isErrorEnvelope(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error && 'code' in error;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('x-returntrip-csrf', csrfToken);
  const response = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const body: ApiErrorBody = isErrorEnvelope(parsed)
      ? parsed.error
      : {
          code: 'HTTP_ERROR',
          message: `The server answered ${response.status}.`,
          retryable: response.status >= 500,
        };
    throw new ApiError(response.status, body);
  }
  return parsed as T;
}

/**
 * Exchanges the one-time token from the URL fragment for a session cookie and a CSRF token,
 * then removes the fragment so the token never lands in history or a shared screenshot.
 */
export async function bootstrapSession(): Promise<void> {
  const match = /(?:^|&)token=([^&]+)/.exec(window.location.hash.slice(1));
  if (!match?.[1]) return;
  const token = decodeURIComponent(match[1]);
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  const session = await request<{ csrf: string }>('/api/v1/session', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  csrfToken = session.csrf;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  projects: (signal?: AbortSignal) =>
    request<{ projects: ProjectSummary[] }>('/api/v1/projects', signal ? { signal } : {}),
  validate: (projectId: string) =>
    request<{ ok: true; configHash: string } | { ok: false; message: string }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/validate`,
      { method: 'POST' },
    ),
  authorizeRepair: (projectId: string) =>
    request<{ authorization: string; expiresInSeconds: number }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/repair-authorization`,
      { method: 'POST' },
    ),
  startRun: (body: {
    projectId: string;
    mode: 'verify' | 'repair';
    authorization?: string;
    fromRunId?: string;
  }) =>
    request<{ runId: string; status: string }>('/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': crypto.randomUUID() },
    }),
  runs: (params: { cursor?: string | null; limit?: number }, signal?: AbortSignal) =>
    request<RunPage>(`/api/v1/runs${query(params)}`, signal ? { signal } : {}),
  run: (id: string, signal?: AbortSignal) =>
    request<RunDetail>(`/api/v1/runs/${encodeURIComponent(id)}`, signal ? { signal } : {}),
  differences: (
    id: string,
    params: { attempt: number; edge: string; kind?: string; field?: string; offset?: number; limit?: number },
    signal?: AbortSignal,
  ) =>
    request<DifferencePage>(
      `/api/v1/runs/${encodeURIComponent(id)}/differences${query(params)}`,
      signal ? { signal } : {},
    ),
  cancel: (id: string) =>
    request<{ canceling: boolean; status: string }>(`/api/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  replay: (id: string) =>
    request<{ runId: string }>(`/api/v1/runs/${encodeURIComponent(id)}/replay`, { method: 'POST' }),
  remove: (id: string) => request<void>(`/api/v1/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  artifactUrl: (runId: string, artifactId: string) =>
    `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
  reportUrl: (runId: string, format: 'json' | 'markdown') =>
    `/api/v1/runs/${encodeURIComponent(runId)}/report?format=${format}`,
  eventsUrl: (runId: string, after: number) =>
    `/api/v1/runs/${encodeURIComponent(runId)}/events${after >= 0 ? `?after=${after}` : ''}`,
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.needsLink ? RELAUNCH_MESSAGE : error.body.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
