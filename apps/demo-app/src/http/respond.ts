import type { ServerResponse } from 'node:http';

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
} as const;

export function sendHtml(res: ServerResponse, status: number, document: string): void {
  send(res, status, 'text/html; charset=utf-8', document, { 'cache-control': 'no-store' });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'cache-control': 'no-store' });
}

export function sendAttachment(
  res: ServerResponse,
  file: { readonly contentType: string; readonly fileName: string; readonly body: string },
): void {
  send(res, 200, file.contentType, file.body, {
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${file.fileName}"`,
  });
}

export function sendAsset(res: ServerResponse, contentType: string, body: Buffer): void {
  send(res, 200, contentType, body, { 'cache-control': 'public, max-age=300' });
}

/** 303 so the browser follows a POST with a GET (post/redirect/get). Relative so it survives a proxy. */
export function redirectSeeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...SECURITY_HEADERS, location, 'content-length': '0' });
  res.end();
}

export function sendMethodNotAllowed(res: ServerResponse, allow: readonly string[]): void {
  send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n', { allow: allow.join(', ') });
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headers: Readonly<Record<string, string>>,
): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'content-type': contentType,
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}
