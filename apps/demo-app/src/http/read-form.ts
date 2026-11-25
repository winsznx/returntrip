import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

export type FormReadResult =
  | { readonly ok: true; readonly form: FormData }
  | { readonly ok: false; readonly reason: 'too-large' | 'malformed' };

// Only used to satisfy the Request constructor; the URL is never fetched.
const PLACEHOLDER_ORIGIN = 'http://ledgerline.invalid/';

/**
 * Decodes a urlencoded or multipart body with the platform's own FormData parser,
 * aborting as soon as more than maxBytes arrive instead of buffering an oversized upload.
 */
export async function readForm(req: IncomingMessage, maxBytes: number): Promise<FormReadResult> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    return { ok: false, reason: 'too-large' };
  }

  let received = 0;
  let exceeded = false;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        exceeded = true;
        controller.error(new RangeError(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  const request = new Request(PLACEHOLDER_ORIGIN, {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] ?? '' },
    body: Readable.toWeb(req).pipeThrough(limiter),
    duplex: 'half',
  });

  try {
    return { ok: true, form: await request.formData() };
  } catch (error) {
    if (exceeded) {
      return { ok: false, reason: 'too-large' };
    }
    if (error instanceof TypeError) {
      return { ok: false, reason: 'malformed' };
    }
    throw error;
  }
}
