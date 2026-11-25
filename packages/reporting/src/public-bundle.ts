import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { COMPARISON_EDGES, type ComparisonEdge, type Difference } from '@returntrip/contracts';
import { readEvidencePack, summarizeEvidence } from '@returntrip/kane-adapter';
import type { ArtifactRecord, RunStore } from '@returntrip/storage';

import { buildRunReport, type RunReport } from './report.ts';

const MAX_DIFFERENCES_PER_EDGE = 200;
const PUBLIC_KINDS = new Set<ArtifactRecord['kind']>([
  'source',
  'export',
  'reexport',
  'patch',
  'restore-upload',
]);

export interface PublicScreenshot {
  readonly attempt: number;
  readonly stage: string;
  /** 0 for the first try of a stage, 1 for its retry. */
  readonly try: number;
  readonly step: string;
  readonly file: string;
}

export interface PublicRun {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly commit: string | null;
  readonly report: RunReport;
  readonly differences: Readonly<
    Record<string, Readonly<Partial<Record<ComparisonEdge, { total: number; items: readonly Difference[] }>>>>
  >;
  readonly files: readonly {
    kind: string;
    attempt: number;
    file: string;
    sha256: string;
    byteLength: number;
  }[];
  readonly screenshots: readonly PublicScreenshot[];
}

export interface PublicIndexEntry {
  readonly runId: string;
  readonly recordedAt: string;
  readonly mode: string;
  readonly outcome: string | null;
  readonly headline: string | null;
  readonly scenario: string | null;
  readonly kaneCreditsUsed: number;
  readonly durationMs: number | null;
}

/** Replaces the local home directory (which names the user) wherever it appears in text. */
export function scrubLocalPaths(text: string, home = homedir()): string {
  return home.length > 1 ? text.split(home).join('~') : text;
}

/**
 * Copies only what is safe to publish: the report (no absolute paths, no Kane share links),
 * bounded difference samples, the public-data CSVs, the patch and page screenshots taken from
 * Kane's evidence packs. The packs themselves are never published: they carry account details
 * and Test Manager share tokens.
 */
export async function exportPublicBundle(input: {
  store: RunStore;
  runId: string;
  outDir: string;
  scenario?: RunReport['scenario'];
  commit?: string | null;
}): Promise<{ dir: string; run: PublicRun }> {
  const { store, runId } = input;
  const report = buildRunReport(store, runId, input.scenario ?? null);
  const dir = join(input.outDir, runId);
  await mkdir(join(dir, 'files'), { recursive: true });
  await mkdir(join(dir, 'screens'), { recursive: true });

  const differences: Record<
    string,
    Partial<Record<ComparisonEdge, { total: number; items: Difference[] }>>
  > = {};
  for (const attempt of report.attempts) {
    const perEdge: Partial<Record<ComparisonEdge, { total: number; items: Difference[] }>> = {};
    for (const edge of COMPARISON_EDGES) {
      const page = store.listDifferences(runId, {
        attempt: attempt.number,
        edge,
        limit: MAX_DIFFERENCES_PER_EDGE,
      });
      if (page.total > 0) perEdge[edge] = { total: page.total, items: page.differences };
    }
    differences[String(attempt.number)] = perEdge;
  }

  const files: PublicRun['files'][number][] = [];
  const screenshots: PublicScreenshot[] = [];
  for (const artifact of store.listArtifacts(runId)) {
    const name = `a${artifact.attempt}-${artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.id}`;
    if (PUBLIC_KINDS.has(artifact.kind)) {
      await writeFile(join(dir, 'files', name), await store.readArtifact(artifact));
      files.push({
        kind: artifact.kind,
        attempt: artifact.attempt,
        file: `files/${name}`,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
      });
    } else if (artifact.kind === 'evidence-pack') {
      const stage = (artifact.provenance.stage as string | undefined) ?? 'browser';
      const base = artifact.relativePath.split(/[\\/]/).at(-1) ?? stage;
      const tryIndex = Number(/-retry(\d+)\./.exec(base)?.[1] ?? 0);
      const label = tryIndex > 0 ? `${stage}-retry${tryIndex}` : stage;
      const pack = await readEvidencePack(store.artifactPath(artifact));
      const summary = summarizeEvidence(pack);
      const picks = summary.steps.filter((step) => step.screenshots.length > 0);
      for (const [index, step] of picks.entries()) {
        const shot = step.screenshots.at(-1);
        if (!shot) continue;
        const file = `screens/a${artifact.attempt}-${label}-${index + 1}.jpg`;
        await writeFile(join(dir, file), pack.read(shot));
        screenshots.push({ attempt: artifact.attempt, stage, try: tryIndex, step: step.step, file });
      }
    }
  }

  const run: PublicRun = {
    schemaVersion: 1,
    recordedAt: report.startedAt,
    commit: input.commit ?? null,
    report,
    differences,
    files,
    screenshots,
  };
  await writeFile(join(dir, 'run.json'), `${scrubLocalPaths(JSON.stringify(run, null, 2))}\n`);
  await writeIndex(input.outDir);
  return { dir, run };
}

/** Rebuilds index.json from every run.json in the bundle directory, newest first. */
export async function writeIndex(outDir: string): Promise<PublicIndexEntry[]> {
  const entries: PublicIndexEntry[] = [];
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(outDir, entry.name, 'run.json'), 'utf8').catch(() => null);
    if (!text) continue;
    const run = JSON.parse(text) as PublicRun;
    entries.push({
      runId: run.report.runId,
      recordedAt: run.recordedAt,
      mode: run.report.mode,
      outcome: run.report.outcome,
      headline: run.report.headline,
      scenario: run.report.scenario?.name ?? null,
      kaneCreditsUsed: run.report.kane.creditsUsed,
      durationMs: run.report.durationMs,
    });
  }
  entries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  await writeFile(
    join(outDir, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, runs: entries }, null, 2)}\n`,
  );
  return entries;
}
