/** Ordered migrations. Each entry runs once, inside a transaction, and bumps user_version. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('verify', 'repair')),
    status TEXT NOT NULL CHECK (status IN ('active', 'finished')),
    phase TEXT NOT NULL,
    outcome TEXT,
    headline TEXT,
    failure_code TEXT,
    config_path TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    contract_hash TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    base_revision TEXT,
    from_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    active_attempt INTEGER NOT NULL DEFAULT 0,
    kane_version TEXT,
    kane_credits_used REAL NOT NULL DEFAULT 0,
    agent_usd REAL NOT NULL DEFAULT 0,
    budget_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_started ON runs (started_at DESC, id DESC);
  CREATE INDEX runs_project ON runs (project, started_at DESC);

  CREATE TABLE attempts (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'repair')),
    target_revision TEXT,
    destination TEXT,
    outcome TEXT,
    patch_sha256 TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (run_id, number)
  );

  CREATE TABLE stages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    stage TEXT NOT NULL,
    outcome TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    credits_used REAL,
    vendor_version TEXT,
    result_json TEXT NOT NULL
  );
  CREATE INDEX stages_run ON stages (run_id, attempt, started_at);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    kind TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
    provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_run ON artifacts (run_id, attempt, kind);

  CREATE TABLE comparisons (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    edge TEXT NOT NULL,
    equivalent INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    PRIMARY KEY (run_id, attempt, edge)
  );

  CREATE TABLE differences (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    edge TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    field TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, attempt, edge, ordinal)
  );
  CREATE INDEX differences_kind ON differences (run_id, attempt, edge, kind, ordinal);

  CREATE TABLE events (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    type TEXT NOT NULL,
    utc TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );

  CREATE TABLE repairs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    cause TEXT,
    agent_version TEXT,
    models_json TEXT NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER NOT NULL,
    patch_sha256 TEXT,
    files_json TEXT NOT NULL,
    lines_changed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, attempt)
  );
  `,
];
