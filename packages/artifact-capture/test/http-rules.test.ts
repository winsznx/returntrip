import { describe, expect, it } from 'vitest';

import {
  compileRoute,
  endToEndHeaders,
  mediaType,
  rewriteOrigin,
  sanitizeHeaderValue,
} from '../src/http-rules.ts';

describe('compileRoute', () => {
  const match = compileRoute('/w/:workspace/export.csv');

  it('returns the decoded workspace for a matching path', () => {
    // #given a path whose workspace segment is percent-encoded
    const path = '/w/caf%C3%A9/export.csv';

    // #when it is matched
    const workspace = match(path);

    // #then the decoded segment is returned
    expect(workspace).toBe('café');
  });

  it.each(['/w/source/export.json', '/w/source/export.csv/extra', '/w//export.csv', '/x/source/export.csv'])(
    'does not match %s',
    (path) => {
      // #given a path that differs from the route
      // #when it is matched
      const workspace = match(path);

      // #then there is no match
      expect(workspace).toBeNull();
    },
  );

  it('returns null for a workspace segment with broken percent-encoding', () => {
    // #given an invalid escape
    const path = '/w/%E0%A4%A/export.csv';

    // #when it is matched
    const workspace = match(path);

    // #then it does not throw and does not match
    expect(workspace).toBeNull();
  });

  it('refuses a route without :workspace', () => {
    // #given a route with no workspace segment
    const compile = (): unknown => compileRoute('/export.csv');

    // #when it is compiled
    // #then it is refused
    expect(compile).toThrow(TypeError);
  });
});

describe('header helpers', () => {
  it('compares media types without parameters or case', () => {
    // #given a content type with a charset and mixed case
    const value = 'Text/CSV; charset=UTF-8';

    // #when its media type is taken
    const type = mediaType(value);

    // #then only the lower-cased type remains
    expect(type).toBe('text/csv');
  });

  it('rewrites only a matching origin prefix', () => {
    // #given an upstream origin and look-alike values
    const from = 'http://127.0.0.1:4100';
    const to = 'http://127.0.0.1:5000';

    // #when each value is rewritten
    const results = [`${from}/w/x`, `${from}?a=1`, from, 'http://127.0.0.1:41000/w/x', '/w/x'].map((value) =>
      rewriteOrigin(value, from, to),
    );

    // #then a port that merely starts the same is left alone
    expect(results).toEqual([`${to}/w/x`, `${to}?a=1`, to, 'http://127.0.0.1:41000/w/x', '/w/x']);
  });

  it('drops standard hop-by-hop headers', () => {
    // #given response headers with transfer-encoding and keep-alive
    const headers = { 'transfer-encoding': 'chunked', 'keep-alive': 'timeout=5', 'content-type': 'text/csv' };

    // #when they are filtered
    const result = endToEndHeaders(headers);

    // #then only the end-to-end header survives
    expect(result).toEqual({ 'content-type': 'text/csv' });
  });

  it('strips control characters from metadata headers', () => {
    // #given a disposition with an embedded CRLF
    const value = 'attachment; filename="a.csv"\r\nX-Injected: 1';

    // #when it is sanitized
    const result = sanitizeHeaderValue(value);

    // #then the line break is gone
    expect(result).toBe('attachment; filename="a.csv"X-Injected: 1');
  });
});
