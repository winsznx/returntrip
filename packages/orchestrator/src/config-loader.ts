import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { type ReturnTripConfig, ReturnTripConfigSchema } from '@returntrip/contracts';
import { parseDocument } from 'yaml';
import type { ZodError } from 'zod';

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(message: string, issues: readonly ConfigIssue[] = []) {
    super(
      issues.length > 0
        ? `${message}\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`
        : message,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** A validated config with every path resolved and checked to sit inside the project root. */
export interface LoadedConfig {
  readonly config: ReturnTripConfig;
  readonly configPath: string;
  readonly configDir: string;
  readonly projectRoot: string;
  readonly configHash: string;
  readonly paths: {
    readonly source: string;
    readonly provenance: string;
    readonly appDir: string | null;
    readonly scenarioPatch: string | null;
    readonly variablesFile: string | null;
  };
}

const MAX_CONFIG_BYTES = 256 * 1024;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function zodIssues(error: ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

async function findProjectRoot(start: string): Promise<string> {
  let current = start;
  for (;;) {
    const marker = await access(resolve(current, '.git')).then(
      () => true,
      () => false,
    );
    if (marker) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function insideRoot(root: string, configDir: string, path: string, label: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(configDir, path);
  const real = await realpath(absolute).catch(() => {
    throw new ConfigError(`${label} does not exist`, [{ path: label, message: absolute }]);
  });
  const rel = relative(root, real);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new ConfigError(`${label} is outside the project root`, [
      { path: label, message: `${real} not under ${root}` },
    ]);
  }
  return real;
}

/**
 * Reads returntrip.yaml with a YAML parser that has no custom tags and no aliases, validates it
 * strictly, and resolves every path relative to the config file.
 */
export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const absoluteConfig = await realpath(resolve(configPath)).catch(() => {
    throw new ConfigError(`config file not found: ${configPath}`);
  });
  const raw = await readFile(absoluteConfig);
  if (raw.byteLength > MAX_CONFIG_BYTES) throw new ConfigError('config file is larger than 256 KiB');

  const document = parseDocument(raw.toString('utf8'), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    customTags: [],
  });
  if (document.errors.length > 0) {
    throw new ConfigError(
      'config is not valid YAML',
      document.errors.map((error) => ({ path: 'yaml', message: error.message })),
    );
  }
  const parsed = ReturnTripConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success)
    throw new ConfigError('config does not match schema version 1', zodIssues(parsed.error));

  const config = parsed.data;
  const configDir = dirname(absoluteConfig);
  const projectRoot = await findProjectRoot(configDir);
  const app = config.application;
  const appDir =
    app.mode === 'managed'
      ? await insideRoot(projectRoot, configDir, app.directory, 'application.directory')
      : null;
  const scenarioPatch =
    app.mode === 'managed' && app.scenario
      ? await insideRoot(projectRoot, configDir, app.scenario.patch, 'application.scenario.patch')
      : null;

  return {
    config,
    configPath: absoluteConfig,
    configDir,
    projectRoot,
    configHash: sha256(canonicalJson(config)),
    paths: {
      source: await insideRoot(projectRoot, configDir, config.source.path, 'source.path'),
      provenance: await insideRoot(projectRoot, configDir, config.source.provenance, 'source.provenance'),
      appDir,
      scenarioPatch,
      variablesFile: config.journey.variablesFile
        ? await insideRoot(projectRoot, configDir, config.journey.variablesFile, 'journey.variablesFile')
        : null,
    },
  };
}

/** Re-hashes the trusted source and refuses to run if it changed since the config was pinned. */
export async function readPinnedSource(loaded: LoadedConfig): Promise<Buffer> {
  const bytes = await readFile(loaded.paths.source);
  const actual = sha256(bytes);
  if (actual !== loaded.config.source.sha256) {
    throw new ConfigError('trusted source changed since it was pinned', [
      { path: 'source.sha256', message: `config says ${loaded.config.source.sha256}, file is ${actual}` },
    ]);
  }
  return bytes;
}
