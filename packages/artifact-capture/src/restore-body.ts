import { createHash } from 'node:crypto';

import { CaptureError } from './capture-error.ts';
import { mediaType } from './http-rules.ts';

export interface RestorePayload {
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string | null;
  readonly contentType: string | null;
  readonly wholeBody: boolean;
}

/**
 * Finds the uploaded file in a buffered request body. Multipart bodies are parsed with the
 * platform's own form-data parser; any other body is hashed whole.
 */
export async function inspectRestoreBody(
  body: Buffer,
  contentType: string | undefined,
  fileField: string,
): Promise<RestorePayload> {
  if (mediaType(contentType) !== 'multipart/form-data' || contentType === undefined) {
    return {
      sha256: sha256(body),
      byteLength: body.length,
      fileName: null,
      contentType: contentType ?? null,
      wholeBody: true,
    };
  }

  let form: FormData;
  try {
    form = await new Request('http://restore.invalid/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch (error) {
    throw new CaptureError('MALFORMED', 'restore upload is not valid multipart/form-data', { cause: error });
  }

  const files = form.getAll(fileField).filter((value): value is File => typeof value !== 'string');
  if (files.length === 0)
    throw new CaptureError('NO_FILE', `restore upload has no file in field "${fileField}"`);
  const [file] = files;
  if (files.length > 1 || !file) {
    throw new CaptureError('AMBIGUOUS', `restore upload has ${files.length} files in field "${fileField}"`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return {
    sha256: sha256(bytes),
    byteLength: bytes.length,
    fileName: file.name || null,
    contentType: file.type || null,
    wholeBody: false,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
