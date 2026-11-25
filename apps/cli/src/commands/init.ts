import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import { EXIT_CODES, type FieldSpec } from '@returntrip/contracts';
import pc from 'picocolors';
import { parseDocument } from 'yaml';

import { confirm, isInteractive } from '../context.ts';
import type { Output } from '../render.ts';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const YEAR = /^\d{4}$/;

/** Splits the first rows of a CSV with RFC 4180 quoting, enough to suggest a contract. */
export function sampleRows(text: string, limit: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < limit; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/** Suggests a type per column from sample values. The user reviews it; nothing is inferred at run time. */
export function suggestFields(header: readonly string[], rows: readonly string[][]): FieldSpec[] {
  return header.map((name, column) => {
    const values = rows.map((row) => row[column] ?? '');
    const present = values.filter((value) => value !== '');
    const nullable = present.length < values.length;
    const base = {
      name,
      nullable,
      nullMarkers: nullable ? [''] : [],
      trim: false,
      unicodeNormalization: 'none' as const,
    };
    const all = (pattern: RegExp): boolean =>
      present.length > 0 && present.every((value) => pattern.test(value));
    const identifierLike =
      /(^id$|_id$|number$|code$|zip$)/i.test(name) || present.some((value) => /^0\d+$/.test(value));
    if (identifierLike) return { ...base, type: 'string' };
    if (all(INTEGER)) return { ...base, type: 'integer' };
    if (all(DECIMAL)) {
      const scale = Math.max(0, ...present.map((value) => value.split('.')[1]?.length ?? 0));
      return { ...base, type: 'decimal', scale: Math.max(scale, 2) };
    }
    const formats: NonNullable<FieldSpec['formats']> = [];
    if (present.some((v) => ISO_DATE.test(v))) formats.push('YYYY-MM-DD');
    if (present.some((v) => US_DATE.test(v))) formats.push('MM/DD/YYYY');
    if (present.some((v) => YEAR.test(v))) formats.push('YYYY');
    if (formats.length > 0 && present.every((v) => ISO_DATE.test(v) || US_DATE.test(v) || YEAR.test(v))) {
      return { ...base, type: 'date', formats };
    }
    return { ...base, type: 'string' };
  });
}

export interface InitOptions {
  readonly source: string;
  readonly appDir?: string;
  readonly origin?: string;
  readonly out?: string;
  readonly project?: string;
  readonly force?: boolean;
  readonly yes?: boolean;
}

function fieldLine(field: FieldSpec): string {
  const parts = [`name: ${field.name}`, `type: ${field.type}`];
  if (field.nullable) parts.push("nullable: true, nullMarkers: ['']");
  if (field.scale !== undefined) parts.push(`scale: ${field.scale}`);
  if (field.formats) parts.push(`formats: [${field.formats.join(', ')}]`);
  return `    - { ${parts.join(', ')} }`;
}

/** Writes a starter returntrip.yaml with the source pinned by hash and a suggested contract. */
export async function init(options: InitOptions, out: Output): Promise<number> {
  if (Boolean(options.appDir) === Boolean(options.origin)) {
    out.info(
      pc.red(
        'Pass exactly one of --app-dir (ReturnTrip starts your app) or --origin (your app is already running).',
      ),
    );
    return EXIT_CODES.INVALID_CONFIG;
  }
  const outPath = resolve(options.out ?? 'returntrip.yaml');
  const sourcePath = resolve(options.source);
  const bytes = await readFile(sourcePath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  const [header, ...rows] = sampleRows(text, 501);
  if (!header || header.length === 0) {
    out.info(pc.red('The source file has no header row.'));
    return EXIT_CODES.INVALID_CONFIG;
  }
  const fields = suggestFields(header, rows);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const rel = (path: string): string => {
    const value = relative(dirname(outPath), path);
    return value.startsWith('.') ? value : `./${value}`;
  };
  const project =
    options.project ??
    (basename(dirname(outPath))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
      'project');
  const application = options.appDir
    ? [
        '  mode: managed',
        `  directory: ${rel(resolve(options.appDir))}`,
        '  lifecycle:',
        "    seed: [node, scripts/seed.js, --csv, '{sourceCsv}', --workspace, '{sourceWorkspace}', --data-dir, '{dataDir}']",
        '    start: [npm, start]',
        '    env:',
        "      PORT: '{port}'",
        "      DATA_DIR: '{dataDir}'",
        '  repairPaths: [src]',
      ]
    : ['  mode: attached', `  origin: ${options.origin}`];

  const yaml = [
    '# ReturnTrip config, schema version 1. Review every line before the first run:',
    '# the field types below are suggestions from the first 500 rows.',
    'schemaVersion: 1',
    `project: ${project}`,
    '',
    'application:',
    ...application,
    '',
    'source:',
    '  kind: manifestCsv',
    `  path: ${rel(sourcePath)}`,
    `  sha256: ${sha}`,
    '  provenance: ./provenance.json',
    '',
    'contract:',
    '  version: 1',
    '  encoding: utf8',
    "  delimiter: ','",
    '  identity:',
    '    mode: multiset',
    '  order: ignore',
    '  extraColumns: reject',
    '  fields:',
    ...fields.map(fieldLine),
    '',
    'journey:',
    '  sourceWorkspace: source',
    "  workspaceUrl: '{origin}/w/{workspace}'",
    "  export: Go to {sourceUrl}. Click the 'Export CSV' link, then verify the page shows '{expectedRowsGrouped} records'.",
    "  createDestination: Go to {origin}/. Create a workspace named '{destinationName}', then verify it shows '0 records'.",
    '  restore: Go to {destinationUrl}. Upload the file {restoreFile} into the CSV file input, click Import, then verify the page shows an import success message.',
    "  reexport: Go to {destinationUrl}. Click the 'Export CSV' link, then verify the page still shows the 'Export CSV' link.",
    '',
    'capture:',
    '  mode: responseProxy',
    '  route: /w/:workspace/export.csv',
    '  contentTypes: [text/csv]',
    '',
    'limits:',
    '  maxKaneCredits: 300',
    '',
  ].join('\n');
  if (parseDocument(yaml).errors.length > 0) throw new Error('generated config is not valid YAML');

  out.info(pc.bold(`Suggested contract from ${header.length} columns and ${rows.length} sample rows:`));
  for (const field of fields)
    out.info(`  ${field.name.padEnd(24)} ${field.type}${field.nullable ? ' (nullable)' : ''}`);
  out.info(pc.dim(`Source sha256 ${sha}`));
  out.info(pc.yellow('Edit the journey objectives so they name your app’s real buttons and labels.'));
  if (!options.yes) {
    if (!isInteractive()) {
      out.info('Writing a config needs --yes in non-interactive environments.');
      return EXIT_CODES.INVALID_CONFIG;
    }
    if (!(await confirm(`Write ${outPath}?`))) return 0;
  }
  try {
    await writeFile(outPath, yaml, { flag: options.force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      out.info(pc.red(`${outPath} exists. Pass --force to overwrite it.`));
      return EXIT_CODES.INVALID_CONFIG;
    }
    throw error;
  }
  const provenancePath = resolve(dirname(outPath), 'provenance.json');
  const provenance = {
    file: rel(sourcePath),
    sha256: sha,
    pinnedAt: new Date().toISOString(),
    origin: 'Describe where this data came from and why it is trusted.',
  };
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  out.info(
    pc.green(`Wrote ${outPath}. Next: returntrip doctor --config ${relative(process.cwd(), outPath)}`),
  );
  return 0;
}
