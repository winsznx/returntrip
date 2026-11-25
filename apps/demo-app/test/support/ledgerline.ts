import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const FIXTURE_CSV = fileURLToPath(new URL('../fixtures/payments.csv', import.meta.url));
export const DEFECTS_DIR = join(APP_DIR, 'defects');

const STARTUP_TIMEOUT_MS = 15_000;
const EXACT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LISTENING_LINE = /Ledgerline listening on (http:\/\/\S+)/;

export interface RunningApp {
  readonly baseUrl: string;
  /** Sends SIGTERM and resolves with the process exit code. */
  stop(): Promise<number | null>;
}

export interface RoundTrip {
  readonly sourceExport: string;
  readonly importStatus: number;
  readonly importLocation: string | null;
  readonly restoredPage: string;
  readonly restoredExport: string;
}

const tempDirs: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ledgerline-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A plain copy of the runnable app (no tests, no node_modules), optionally with one defect patch applied. */
export function copyApp(defectPatch?: string): string {
  const dir = makeTempDir(defectPatch === undefined ? 'healthy' : 'defect');
  for (const entry of ['package.json', 'src', 'public']) {
    cpSync(join(APP_DIR, entry), join(dir, entry), { recursive: true });
  }
  if (defectPatch !== undefined) {
    // GIT_CEILING_DIRECTORIES keeps git from discovering any enclosing repository.
    execFileSync('git', ['apply', join(DEFECTS_DIR, defectPatch)], {
      cwd: dir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
      stdio: 'pipe',
    });
  }
  return dir;
}

export function seedWorkspace(
  appDir: string,
  dataDir: string,
  workspace: { readonly slug: string; readonly name: string; readonly csvPath: string },
): string {
  return execFileSync(
    process.execPath,
    [
      'src/seed.ts',
      '--data-dir',
      dataDir,
      '--workspace',
      workspace.slug,
      '--name',
      workspace.name,
      '--csv',
      workspace.csvPath,
    ],
    { cwd: appDir, encoding: 'utf8', stdio: 'pipe' },
  );
}

export async function startApp(appDir: string, dataDir: string): Promise<RunningApp> {
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: appDir,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const baseUrl = await waitForListening(child, () => stderr);
  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) {
        return child.exitCode;
      }
      child.kill('SIGTERM');
      const [code] = await once(child, 'exit');
      return typeof code === 'number' ? code : null;
    },
  };
}

async function waitForListening(child: ChildProcess, stderr: () => string): Promise<string> {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error('server stdout is not piped');
  }
  const lines = createInterface({ input: stdout });
  const timeout = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
  const exited = once(child, 'exit', { signal: timeout }).then(([code]) => {
    throw new Error(`server exited with ${String(code)} before listening:\n${stderr()}`);
  });
  const listening = (async () => {
    for await (const line of lines) {
      const match = LISTENING_LINE.exec(line);
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
    throw new Error(`server closed stdout before listening:\n${stderr()}`);
  })();
  try {
    return await Promise.race([listening, exited]);
  } finally {
    // Keep draining stdout so request logging never blocks the child on a full pipe.
    stdout.resume();
    exited.catch(() => undefined);
  }
}

export async function createWorkspace(baseUrl: string, name: string): Promise<Response> {
  return fetch(`${baseUrl}/workspaces`, {
    method: 'POST',
    body: new URLSearchParams({ name }),
    redirect: 'manual',
  });
}

export async function uploadCsv(
  baseUrl: string,
  slug: string,
  contents: string | Uint8Array<ArrayBuffer>,
  fileName = 'payments.csv',
): Promise<Response> {
  const form = new FormData();
  form.set('file', new Blob([contents], { type: 'text/csv' }), fileName);
  return fetch(`${baseUrl}/w/${slug}/import`, { method: 'POST', body: form, redirect: 'manual' });
}

export async function fetchExport(baseUrl: string, slug: string): Promise<Response> {
  return fetch(`${baseUrl}/w/${slug}/export.csv`);
}

/** Response.text() silently drops a leading BOM; exports must be checked byte for byte. */
export async function readExactText(response: Response): Promise<string> {
  return EXACT_UTF8.decode(await response.arrayBuffer());
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

/**
 * The exact flow a browser user drives: export the source workspace, create an empty one,
 * upload the exported file through the import form, then export the new workspace.
 */
export async function runRoundTrip(appDir: string): Promise<RoundTrip> {
  const dataDir = makeTempDir('data');
  seedWorkspace(appDir, dataDir, { slug: 'source', name: 'Source payments', csvPath: FIXTURE_CSV });
  const app = await startApp(appDir, dataDir);
  try {
    const sourceBytes = new Uint8Array(await (await fetchExport(app.baseUrl, 'source')).arrayBuffer());
    const created = await createWorkspace(app.baseUrl, 'Restored payments');
    if (created.status !== 303) {
      throw new Error(`creating the restore workspace failed with ${created.status}`);
    }
    const imported = await uploadCsv(app.baseUrl, 'restored-payments', sourceBytes, 'source-payments.csv');
    const importLocation = imported.headers.get('location');
    const restoredPage = await fetchText(new URL(importLocation ?? '/w/restored-payments', app.baseUrl).href);
    const restoredExport = await readExactText(await fetchExport(app.baseUrl, 'restored-payments'));
    return {
      sourceExport: EXACT_UTF8.decode(sourceBytes),
      importStatus: imported.status,
      importLocation,
      restoredPage,
      restoredExport,
    };
  } finally {
    await app.stop();
  }
}

export function readFixture(): string {
  return readFileSync(FIXTURE_CSV, 'utf8');
}
