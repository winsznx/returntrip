const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validates the upstream the proxy may talk to: a bare http(s) origin on loopback. Anything
 * else would turn the proxy into a way to reach other hosts.
 */
export function parseLoopbackOrigin(value: string): URL {
  const url = URL.parse(value);
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(
      `upstream must be a bare loopback origin such as http://127.0.0.1:4310, got ${value}`,
    );
  }
  return url;
}

export type RouteMatcher = (path: string) => string | null;

/**
 * Compiles a route such as `/w/:workspace/export.csv` into a matcher that returns the decoded
 * workspace segment, or null. Other `:param` segments match any single segment.
 */
export function compileRoute(pattern: string): RouteMatcher {
  const expected = pattern.split('/');
  const workspaceIndex = expected.indexOf(':workspace');
  if (workspaceIndex === -1) throw new TypeError(`route ${pattern} has no :workspace segment`);

  return (path) => {
    const actual = path.split('/');
    if (actual.length !== expected.length) return null;
    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index] ?? '';
      const got = actual[index] ?? '';
      if (want.startsWith(':')) {
        if (got === '') return null;
      } else if (want !== got) {
        return null;
      }
    }
    try {
      return decodeURIComponent(actual[workspaceIndex] ?? '');
    } catch {
      return null;
    }
  };
}

/** `text/csv; charset=utf-8` → `text/csv`. */
export function mediaType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return type ? type : null;
}

export function pathWithoutQuery(target: string): string {
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type HeaderValue = string | string[] | number | undefined;

/** Drops hop-by-hop headers, including any the Connection header names. */
export function endToEndHeaders(
  headers: Readonly<Record<string, HeaderValue>>,
): Record<string, string | string[]> {
  const connection = headers.connection;
  const named = new Set(
    (Array.isArray(connection) ? connection.join(',') : String(connection ?? ''))
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    result[lower] = typeof value === 'number' ? String(value) : value;
  }
  return result;
}

/** Replaces a leading `from` origin with `to`, leaving any other value alone. */
export function rewriteOrigin(value: string, from: string, to: string): string {
  if (value === from) return to;
  return value.startsWith(`${from}/`) || value.startsWith(`${from}?`)
    ? `${to}${value.slice(from.length)}`
    : value;
}

/** Strips control characters and bounds the length of a header kept as metadata. */
export function sanitizeHeaderValue(value: string | undefined, maxLength = 512): string | null {
  if (value === undefined) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
  return cleaned === '' ? null : cleaned;
}
