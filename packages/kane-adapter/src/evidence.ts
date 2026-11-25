import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { isJsonObject, stringField } from './kane-events.ts';
import type { EvidencePack } from './zip-reader.ts';

export interface CopiedEvidencePack {
  readonly sourcePath: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Copies a sealed pack into `destDir`, hashing the bytes as they are copied so the recorded
 * sha256 is exactly what landed on disk. The original is only read. The copy is made read-only
 * and the call fails rather than overwrite an existing copy.
 */
export async function copyEvidencePack(sourcePath: string, destDir: string): Promise<CopiedEvidencePack> {
  const stats = await lstat(sourcePath);
  if (!stats.isFile()) throw new Error(`evidence pack ${sourcePath} is not a regular file`);

  await mkdir(destDir, { recursive: true });
  const destination = join(destDir, basename(sourcePath));
  const partial = join(destDir, `.${basename(sourcePath)}.${randomUUID()}.partial`);
  const hash = createHash('sha256');
  let byteLength = 0;

  try {
    await pipeline(
      createReadStream(sourcePath),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          byteLength += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
    );
    await chmod(partial, 0o444);
    // link() fails with EEXIST instead of replacing, which rename() would do silently.
    await link(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
  return { sourcePath, path: destination, sha256: hash.digest('hex'), byteLength };
}

export interface EvidenceStep {
  /** Test slug directory under `tests/`. */
  readonly test: string;
  /** Step directory name, such as `3-0-3`. */
  readonly step: string;
  readonly ordinal: number;
  /** `status` from the step's `step.json`, null when absent or unreadable. */
  readonly status: string | null;
  readonly screenshots: readonly string[];
}

export interface HarRequest {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly mimeType: string | null;
  readonly startedDateTime: string | null;
}

export interface EvidenceSummary {
  readonly steps: readonly EvidenceStep[];
  readonly requests: readonly HarRequest[];
  readonly failedStepScreenshot: string | null;
  /** Pack members that could not be read or parsed. */
  readonly warnings: readonly string[];
}

const STEP_FILE = /^tests\/([^/]+)\/steps\/([^/]+)\/([^/]+)$/;
const SCREENSHOT_FILE = /^screenshot\.(?:jpe?g|png|webp)$/i;
const HAR_FILE = /^tests\/[^/]+\/logs\/[^/]+\.har$/;

/**
 * Lists what a pack shows without trusting it: screenshots per step, the HAR request list and
 * the screenshot of the last failed step. HAR URLs keep origin and path only, because query
 * strings can carry signed tokens.
 */
export function summarizeEvidence(pack: EvidencePack): EvidenceSummary {
  const warnings: string[] = [];
  const steps = new Map<
    string,
    { test: string; step: string; screenshots: string[]; status: string | null }
  >();

  for (const entry of pack.entries) {
    const match = STEP_FILE.exec(entry.name);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const [, test, step, file] = match;
    const key = `${test}/${step}`;
    const record = steps.get(key) ?? { test, step, screenshots: [], status: null };
    steps.set(key, record);
    if (SCREENSHOT_FILE.test(file)) record.screenshots.push(entry.name);
    if (file === 'step.json') {
      const parsed = readJson(pack, entry.name, warnings);
      record.status = isJsonObject(parsed) ? stringField(parsed, 'status') : null;
    }
  }

  const orderedSteps: EvidenceStep[] = [...steps.values()]
    .map((record) => ({ ...record, ordinal: stepOrdinal(record.step) }))
    .sort((a, b) => a.test.localeCompare(b.test) || a.ordinal - b.ordinal || a.step.localeCompare(b.step));

  const requests: HarRequest[] = [];
  for (const entry of pack.entries) {
    if (!HAR_FILE.test(entry.name)) continue;
    requests.push(...harRequests(readJson(pack, entry.name, warnings), entry.name, warnings));
  }

  const failed = orderedSteps.findLast((step) => step.status === 'failed' && step.screenshots.length > 0);
  return {
    steps: orderedSteps,
    requests,
    failedStepScreenshot: failed?.screenshots[0] ?? null,
    warnings,
  };
}

function stepOrdinal(step: string): number {
  const ordinal = Number.parseInt(step, 10);
  return Number.isFinite(ordinal) ? ordinal : Number.MAX_SAFE_INTEGER;
}

function readJson(pack: EvidencePack, name: string, warnings: string[]): unknown {
  try {
    return JSON.parse(pack.read(name).toString('utf8'));
  } catch (error) {
    warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function harRequests(har: unknown, name: string, warnings: string[]): HarRequest[] {
  const log = isJsonObject(har) ? har.log : null;
  const entries = isJsonObject(log) ? log.entries : null;
  if (!Array.isArray(entries)) {
    if (har !== null) warnings.push(`${name}: not a HAR log`);
    return [];
  }
  const requests: HarRequest[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry) || !isJsonObject(entry.request)) continue;
    const method = stringField(entry.request, 'method');
    const url = stringField(entry.request, 'url');
    if (!method || !url) continue;
    const response = isJsonObject(entry.response) ? entry.response : null;
    const content = response && isJsonObject(response.content) ? response.content : null;
    const status = response?.status;
    requests.push({
      method,
      url: withoutQuery(url),
      status: typeof status === 'number' && status > 0 ? status : null,
      mimeType: content ? stringField(content, 'mimeType') : null,
      startedDateTime: stringField(entry, 'startedDateTime'),
    });
  }
  return requests;
}

function withoutQuery(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return url.split(/[?#]/, 1)[0] ?? url;
  const origin = parsed.origin === 'null' ? parsed.protocol : parsed.origin;
  return `${origin}${parsed.pathname}`;
}
