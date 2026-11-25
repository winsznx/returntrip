import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import {
  type BrowserResult,
  type BrowserStage,
  type ComparisonEdge,
  type Difference,
  type EdgeSummary,
  type RunEvent,
  RunEventSchema,
  type RunEventType,
  type RunMode,
  type RunOutcome,
  type RunPhase,
} from '@returntrip/contracts';

import {
  assertSafeFileName,
  containedPath,
  copyFileAtomic,
  ensurePrivateDir,
  sha256File,
  sha256Hex,
  writeFileAtomic,
} from './files.ts';
import { MIGRATIONS } from './schema.ts';

export interface RunBudget {
  readonly maxKaneCredits: number;
  readonly maxRepairAttempts: number;
  readonly maxAgentBudgetUsd: number;
}

export interface RunRecord {
  readonly id: string;
  readonly project: string;
  readonly mode: RunMode;
  readonly status: 'active' | 'finished';
  readonly phase: RunPhase;
  readonly outcome: RunOutcome | null;
  readonly headline: string | null;
  readonly failureCode: string | null;
  readonly configPath: string;
  readonly configHash: string;
  readonly contractHash: string;
  readonly sourceHash: string;
  readonly baseRevision: string | null;
  readonly fromRunId: string | null;
  readonly activeAttempt: number;
  readonly kaneVersion: string | null;
  readonly kaneCreditsUsed: number;
  readonly agentUsd: number;
  readonly budget: RunBudget;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface AttemptRecord {
  readonly runId: string;
  readonly number: number;
  readonly kind: 'initial' | 'repair';
  readonly targetRevision: string | null;
  readonly destination: string | null;
  readonly outcome: string | null;
  readonly patchSha256: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface StageRecord {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
  readonly stage: BrowserStage;
  readonly result: BrowserResult;
}

export type ArtifactKind =
  | 'source'
  | 'export'
  | 'reexport'
  | 'restore-upload'
  | 'kane-stdout'
  | 'kane-stderr'
  | 'evidence-pack'
  | 'comparison'
  | 'repair-request'
  | 'agent-output'
  | 'patch'
  | 'build-log'
  | 'target-log'
  | 'proxy-log'
  | 'report-json'
  | 'report-markdown';

export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
  readonly kind: ArtifactKind;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly visibility: 'private' | 'public';
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ComparisonRecord {
  readonly attempt: number;
  readonly edge: ComparisonEdge;
  readonly summary: EdgeSummary;
}

export interface RepairRecord {
  readonly runId: string;
  readonly attempt: number;
  readonly status: string;
  readonly reason: string | null;
  readonly cause: string | null;
  readonly agentVersion: string | null;
  readonly models: readonly string[];
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly patchSha256: string | null;
  readonly files: readonly string[];
  readonly linesChanged: number;
  readonly createdAt: string;
}

export interface NewRun {
  readonly project: string;
  readonly mode: RunMode;
  readonly configPath: string;
  readonly configHash: string;
  readonly contractHash: string;
  readonly sourceHash: string;
  readonly baseRevision: string | null;
  readonly fromRunId?: string | null;
  readonly budget: RunBudget;
}

export interface RunPage {
  readonly runs: readonly RunRecord[];
  readonly nextCursor: string | null;
}

type Row = Record<string, SQLInputValue>;

const RUN_COLUMNS: Readonly<Record<string, string>> = {
  phase: 'phase',
  status: 'status',
  outcome: 'outcome',
  headline: 'headline',
  failureCode: 'failure_code',
  activeAttempt: 'active_attempt',
  kaneVersion: 'kane_version',
  kaneCreditsUsed: 'kane_credits_used',
  agentUsd: 'agent_usd',
  baseRevision: 'base_revision',
  finishedAt: 'finished_at',
};

type RunPatch = Partial<
  Pick<
    RunRecord,
    | 'phase'
    | 'status'
    | 'outcome'
    | 'headline'
    | 'failureCode'
    | 'activeAttempt'
    | 'kaneVersion'
    | 'kaneCreditsUsed'
    | 'agentUsd'
    | 'baseRevision'
    | 'finishedAt'
  >
>;

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`column ${key} is not text`);
  return value;
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${key} is not numeric`);
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : num(row, key);
}

function parseJson<T>(row: Row, key: string): T {
  return JSON.parse(str(row, key)) as T;
}

function toRun(row: Row): RunRecord {
  return {
    id: str(row, 'id'),
    project: str(row, 'project'),
    mode: str(row, 'mode') as RunMode,
    status: str(row, 'status') as RunRecord['status'],
    phase: str(row, 'phase') as RunPhase,
    outcome: strOrNull(row, 'outcome') as RunOutcome | null,
    headline: strOrNull(row, 'headline'),
    failureCode: strOrNull(row, 'failure_code'),
    configPath: str(row, 'config_path'),
    configHash: str(row, 'config_hash'),
    contractHash: str(row, 'contract_hash'),
    sourceHash: str(row, 'source_hash'),
    baseRevision: strOrNull(row, 'base_revision'),
    fromRunId: strOrNull(row, 'from_run_id'),
    activeAttempt: num(row, 'active_attempt'),
    kaneVersion: strOrNull(row, 'kane_version'),
    kaneCreditsUsed: num(row, 'kane_credits_used'),
    agentUsd: num(row, 'agent_usd'),
    budget: parseJson<RunBudget>(row, 'budget_json'),
    startedAt: str(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
  };
}

function toAttempt(row: Row): AttemptRecord {
  return {
    runId: str(row, 'run_id'),
    number: num(row, 'number'),
    kind: str(row, 'kind') as AttemptRecord['kind'],
    targetRevision: strOrNull(row, 'target_revision'),
    destination: strOrNull(row, 'destination'),
    outcome: strOrNull(row, 'outcome'),
    patchSha256: strOrNull(row, 'patch_sha256'),
    startedAt: str(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
  };
}

function toArtifact(row: Row): ArtifactRecord {
  return {
    id: str(row, 'id'),
    runId: str(row, 'run_id'),
    attempt: num(row, 'attempt'),
    kind: str(row, 'kind') as ArtifactKind,
    relativePath: str(row, 'relative_path'),
    sha256: str(row, 'sha256'),
    byteLength: num(row, 'byte_length'),
    mediaType: str(row, 'media_type'),
    visibility: str(row, 'visibility') as ArtifactRecord['visibility'],
    provenance: parseJson<Record<string, unknown>>(row, 'provenance_json'),
    createdAt: str(row, 'created_at'),
  };
}

function toRepair(row: Row): RepairRecord {
  return {
    runId: str(row, 'run_id'),
    attempt: num(row, 'attempt'),
    status: str(row, 'status'),
    reason: strOrNull(row, 'reason'),
    cause: strOrNull(row, 'cause'),
    agentVersion: strOrNull(row, 'agent_version'),
    models: parseJson<string[]>(row, 'models_json'),
    costUsd: numOrNull(row, 'cost_usd'),
    durationMs: num(row, 'duration_ms'),
    patchSha256: strOrNull(row, 'patch_sha256'),
    files: parseJson<string[]>(row, 'files_json'),
    linesChanged: num(row, 'lines_changed'),
    createdAt: str(row, 'created_at'),
  };
}

function encodeCursor(run: RunRecord): string {
  return Buffer.from(JSON.stringify([run.startedAt, run.id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (Array.isArray(parsed) && parsed.length === 2) {
    const [startedAt, id] = parsed as unknown[];
    if (typeof startedAt === 'string' && typeof id === 'string') return [startedAt, id];
  }
  throw new Error('invalid cursor');
}

type AppendableEvent<T extends RunEventType = RunEventType> = {
  readonly type: T;
  readonly attempt: number;
  readonly payload: Extract<RunEvent, { type: T }>['payload'];
};

/**
 * Local persistence for runs. One SQLite file for metadata, and a private directory of immutable
 * artifacts per run. Every artifact row carries the sha256 of the bytes on disk.
 */
export class RunStore {
  readonly root: string;
  readonly #db: DatabaseSync;
  readonly #events = new EventEmitter();
  readonly #runClocks = new Map<string, number>();

  private constructor(root: string, db: DatabaseSync) {
    this.root = root;
    this.#db = db;
    this.#events.setMaxListeners(100);
  }

  static async open(root: string): Promise<RunStore> {
    await ensurePrivateDir(root);
    await ensurePrivateDir(join(root, 'runs'));
    const db = new DatabaseSync(join(root, 'returntrip.db'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const store = new RunStore(root, db);
    store.#migrate();
    return store;
  }

  close(): void {
    this.#events.removeAllListeners();
    this.#db.close();
  }

  #migrate(): void {
    const current = num(this.#db.prepare('PRAGMA user_version').get() as Row, 'user_version');
    MIGRATIONS.slice(current).forEach((sql, offset) => {
      this.#transaction(() => {
        this.#db.exec(sql);
        this.#db.exec(`PRAGMA user_version = ${current + offset + 1}`);
      });
    });
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  runDir(runId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error(`invalid run id: ${runId}`);
    return join(this.root, 'runs', runId);
  }

  createRun(input: NewRun): RunRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO runs (id, project, mode, status, phase, config_path, config_hash, contract_hash, source_hash,
           base_revision, from_run_id, budget_json, started_at)
         VALUES (?, ?, ?, 'active', 'CREATED', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.mode,
        input.configPath,
        input.configHash,
        input.contractHash,
        input.sourceHash,
        input.baseRevision,
        input.fromRunId ?? null,
        JSON.stringify(input.budget),
        now,
      );
    this.#runClocks.set(id, performance.now());
    return this.getRun(id) ?? this.#missing(id);
  }

  #missing(id: string): never {
    throw new Error(`run ${id} not found`);
  }

  getRun(id: string): RunRecord | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  updateRun(id: string, patch: RunPatch): RunRecord {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => {
        const column = RUN_COLUMNS[key];
        if (!column) throw new Error(`unknown run field ${key}`);
        return `${column} = ?`;
      });
      this.#db
        .prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...entries.map(([, value]) => value as SQLInputValue), id);
    }
    return this.getRun(id) ?? this.#missing(id);
  }

  listRuns(options: { limit?: number; cursor?: string | null; project?: string } = {}): RunPage {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.project) {
      clauses.push('project = ?');
      params.push(options.project);
    }
    if (options.cursor) {
      const [startedAt, id] = decodeCursor(options.cursor);
      clauses.push('(started_at < ? OR (started_at = ? AND id < ?))');
      params.push(startedAt, startedAt, id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as Row[];
    const runs = rows.slice(0, limit).map(toRun);
    const last = runs.at(-1);
    return { runs, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  activeRuns(): RunRecord[] {
    return (this.#db.prepare("SELECT * FROM runs WHERE status = 'active'").all() as Row[]).map(toRun);
  }

  /** Runs left active by a crashed process can't be trusted; close them as interrupted. */
  reconcileInterrupted(isOwnedByThisProcess: (runId: string) => boolean): RunRecord[] {
    const orphaned = this.activeRuns().filter((run) => !isOwnedByThisProcess(run.id));
    for (const run of orphaned) {
      this.updateRun(run.id, {
        status: 'finished',
        phase: 'FINISHED',
        outcome: 'EXECUTION_FAILED',
        failureCode: 'INTERRUPTED',
        headline: 'The run was interrupted before it finished. No verdict was recorded.',
        finishedAt: new Date().toISOString(),
      });
    }
    return orphaned;
  }

  async deleteRun(id: string): Promise<void> {
    const run = this.getRun(id);
    if (!run) return;
    if (run.status === 'active') throw new Error('refusing to delete an active run');
    this.#db.prepare('DELETE FROM runs WHERE id = ?').run(id);
    await rm(this.runDir(id), { recursive: true, force: true });
  }

  startAttempt(
    runId: string,
    number: number,
    kind: AttemptRecord['kind'],
    targetRevision: string | null,
  ): void {
    this.#db
      .prepare(
        'INSERT INTO attempts (run_id, number, kind, target_revision, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, number, kind, targetRevision, new Date().toISOString());
    this.updateRun(runId, { activeAttempt: number });
  }

  finishAttempt(
    runId: string,
    number: number,
    fields: { outcome: string; destination?: string | null; patchSha256?: string | null },
  ): void {
    this.#db
      .prepare(
        `UPDATE attempts SET outcome = ?, destination = COALESCE(?, destination),
           patch_sha256 = COALESCE(?, patch_sha256), finished_at = ? WHERE run_id = ? AND number = ?`,
      )
      .run(
        fields.outcome,
        fields.destination ?? null,
        fields.patchSha256 ?? null,
        new Date().toISOString(),
        runId,
        number,
      );
  }

  setAttemptDestination(runId: string, number: number, destination: string): void {
    this.#db
      .prepare('UPDATE attempts SET destination = ? WHERE run_id = ? AND number = ?')
      .run(destination, runId, number);
  }

  listAttempts(runId: string): AttemptRecord[] {
    return (
      this.#db.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY number').all(runId) as Row[]
    ).map(toAttempt);
  }

  recordStage(runId: string, attempt: number, stage: BrowserStage, result: BrowserResult): StageRecord {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO stages (id, run_id, attempt, stage, outcome, started_at, finished_at, duration_ms,
           credits_used, vendor_version, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        attempt,
        stage,
        result.outcome,
        result.startedAt,
        result.finishedAt,
        Math.round(result.durationMs),
        result.creditsUsed,
        result.version,
        JSON.stringify(result),
      );
    return { id, runId, attempt, stage, result };
  }

  listStages(runId: string): StageRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM stages WHERE run_id = ? ORDER BY attempt, started_at')
      .all(runId) as Row[];
    return rows.map((row) => ({
      id: str(row, 'id'),
      runId: str(row, 'run_id'),
      attempt: num(row, 'attempt'),
      stage: str(row, 'stage') as BrowserStage,
      result: parseJson<BrowserResult>(row, 'result_json'),
    }));
  }

  async writeArtifact(input: {
    runId: string;
    attempt: number;
    kind: ArtifactKind;
    fileName: string;
    data: Uint8Array | string;
    mediaType: string;
    provenance?: Record<string, unknown>;
    visibility?: 'private' | 'public';
  }): Promise<ArtifactRecord> {
    assertSafeFileName(input.fileName);
    const relativePath = join(`a${input.attempt}`, input.fileName);
    const absolute = containedPath(this.runDir(input.runId), relativePath);
    await writeFileAtomic(absolute, input.data);
    const bytes = typeof input.data === 'string' ? Buffer.from(input.data) : input.data;
    return this.#insertArtifact(input, relativePath, sha256Hex(bytes), bytes.byteLength);
  }

  /** Copies an existing file (a capture, an evidence pack) into the run, hashing what was stored. */
  async importArtifact(input: {
    runId: string;
    attempt: number;
    kind: ArtifactKind;
    fileName: string;
    sourcePath: string;
    mediaType: string;
    provenance?: Record<string, unknown>;
    expectedSha256?: string;
  }): Promise<ArtifactRecord> {
    assertSafeFileName(input.fileName);
    const relativePath = join(`a${input.attempt}`, input.fileName);
    const absolute = containedPath(this.runDir(input.runId), relativePath);
    await copyFileAtomic(input.sourcePath, absolute);
    const { sha256, byteLength } = await sha256File(absolute);
    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      await unlink(absolute);
      throw new Error(`artifact hash changed while copying ${input.fileName}`);
    }
    return this.#insertArtifact(input, relativePath, sha256, byteLength);
  }

  #insertArtifact(
    input: {
      runId: string;
      attempt: number;
      kind: ArtifactKind;
      mediaType: string;
      provenance?: Record<string, unknown>;
      visibility?: 'private' | 'public';
    },
    relativePath: string,
    sha256: string,
    byteLength: number,
  ): ArtifactRecord {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO artifacts (id, run_id, attempt, kind, relative_path, sha256, byte_length, media_type,
           visibility, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.attempt,
        input.kind,
        relativePath,
        sha256,
        byteLength,
        input.mediaType,
        input.visibility ?? 'private',
        JSON.stringify(input.provenance ?? {}),
        new Date().toISOString(),
      );
    return this.getArtifact(input.runId, id) ?? this.#missing(id);
  }

  getArtifact(runId: string, artifactId: string): ArtifactRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? AND id = ?')
      .get(runId, artifactId) as Row | undefined;
    return row ? toArtifact(row) : null;
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return (
      this.#db
        .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY attempt, created_at')
        .all(runId) as Row[]
    ).map(toArtifact);
  }

  artifactPath(artifact: ArtifactRecord): string {
    return containedPath(this.runDir(artifact.runId), artifact.relativePath);
  }

  /** Reads an artifact and refuses to return bytes that no longer match the recorded hash. */
  async readArtifact(artifact: ArtifactRecord): Promise<Buffer> {
    const bytes = await readFile(this.artifactPath(artifact));
    if (sha256Hex(bytes) !== artifact.sha256) {
      throw new Error(`artifact ${artifact.id} failed its integrity check`);
    }
    return bytes;
  }

  recordComparison(
    runId: string,
    attempt: number,
    edge: ComparisonEdge,
    summary: EdgeSummary,
    differences: readonly Difference[],
  ): void {
    this.#transaction(() => {
      this.#db
        .prepare(
          'INSERT OR REPLACE INTO comparisons (run_id, attempt, edge, equivalent, summary_json) VALUES (?, ?, ?, ?, ?)',
        )
        .run(runId, attempt, edge, summary.isEquivalent ? 1 : 0, JSON.stringify(summary));
      this.#db
        .prepare('DELETE FROM differences WHERE run_id = ? AND attempt = ? AND edge = ?')
        .run(runId, attempt, edge);
      const insert = this.#db.prepare(
        `INSERT INTO differences (run_id, attempt, edge, ordinal, id, kind, field, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      differences.forEach((difference, ordinal) => {
        insert.run(
          runId,
          attempt,
          edge,
          ordinal,
          difference.id,
          difference.kind,
          difference.field ?? null,
          JSON.stringify(difference),
        );
      });
    });
  }

  listComparisons(runId: string): ComparisonRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM comparisons WHERE run_id = ? ORDER BY attempt, edge')
      .all(runId) as Row[];
    return rows.map((row) => ({
      attempt: num(row, 'attempt'),
      edge: str(row, 'edge') as ComparisonEdge,
      summary: parseJson<EdgeSummary>(row, 'summary_json'),
    }));
  }

  listDifferences(
    runId: string,
    query: {
      attempt: number;
      edge: ComparisonEdge;
      kind?: string;
      field?: string;
      offset?: number;
      limit?: number;
    },
  ): { differences: Difference[]; total: number } {
    const clauses = ['run_id = ?', 'attempt = ?', 'edge = ?'];
    const params: SQLInputValue[] = [runId, query.attempt, query.edge];
    if (query.kind) {
      clauses.push('kind = ?');
      params.push(query.kind);
    }
    if (query.field) {
      clauses.push('field = ?');
      params.push(query.field);
    }
    const where = clauses.join(' AND ');
    const total = num(
      this.#db.prepare(`SELECT COUNT(*) AS n FROM differences WHERE ${where}`).get(...params) as Row,
      'n',
    );
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const rows = this.#db
      .prepare(`SELECT payload_json FROM differences WHERE ${where} ORDER BY ordinal LIMIT ? OFFSET ?`)
      .all(...params, limit, Math.max(query.offset ?? 0, 0)) as Row[];
    return { differences: rows.map((row) => parseJson<Difference>(row, 'payload_json')), total };
  }

  recordRepair(record: Omit<RepairRecord, 'createdAt'>): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO repairs (run_id, attempt, status, reason, cause, agent_version, models_json, cost_usd,
           duration_ms, patch_sha256, files_json, lines_changed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.attempt,
        record.status,
        record.reason,
        record.cause,
        record.agentVersion,
        JSON.stringify(record.models),
        record.costUsd,
        Math.round(record.durationMs),
        record.patchSha256,
        JSON.stringify(record.files),
        record.linesChanged,
        new Date().toISOString(),
      );
  }

  listRepairs(runId: string): RepairRecord[] {
    return (
      this.#db.prepare('SELECT * FROM repairs WHERE run_id = ? ORDER BY attempt').all(runId) as Row[]
    ).map(toRepair);
  }

  appendEvent<T extends RunEventType>(runId: string, event: AppendableEvent<T>): RunEvent {
    const started = this.#runClocks.get(runId) ?? performance.now();
    this.#runClocks.set(runId, started);
    const stored = this.#transaction(() => {
      const last = this.#db.prepare('SELECT MAX(seq) AS seq FROM events WHERE run_id = ?').get(runId) as Row;
      const seq = (numOrNull(last, 'seq') ?? -1) + 1;
      const candidate = RunEventSchema.parse({
        schemaVersion: 1,
        runId,
        seq,
        attempt: event.attempt,
        utc: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        type: event.type,
        payload: event.payload,
      });
      this.#db
        .prepare(
          'INSERT INTO events (run_id, seq, attempt, type, utc, elapsed_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          runId,
          seq,
          candidate.attempt,
          candidate.type,
          candidate.utc,
          candidate.elapsedMs,
          JSON.stringify(candidate.payload),
        );
      return candidate;
    });
    this.#events.emit(runId, stored);
    return stored;
  }

  listEvents(runId: string, afterSeq = -1): RunEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as Row[];
    return rows.map((row) =>
      RunEventSchema.parse({
        schemaVersion: 1,
        runId,
        seq: num(row, 'seq'),
        attempt: num(row, 'attempt'),
        utc: str(row, 'utc'),
        elapsedMs: num(row, 'elapsed_ms'),
        type: str(row, 'type'),
        payload: parseJson<unknown>(row, 'payload_json'),
      }),
    );
  }

  /** Live events for one run. Returns an unsubscribe function. */
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.#events.on(runId, listener);
    return () => {
      this.#events.off(runId, listener);
    };
  }

  /** Removes temp files a crash left behind; never touches finalized artifacts. */
  async sweepTempFiles(runId: string): Promise<number> {
    let removed = 0;
    const dir = this.runDir(runId);
    const walk = async (path: string): Promise<void> => {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.tmp')) {
          await unlink(full);
          removed += 1;
        }
      }
    };
    await walk(dir);
    return removed;
  }
}
