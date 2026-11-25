import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { NewPayment, Payment } from './domain/payment.ts';
import type { Workspace, WorkspaceSummary } from './domain/workspace.ts';

const DATABASE_FILE = 'ledgerline.sqlite';
const SCHEMA_VERSION = 1;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const SCHEMA = `
  CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    voucher_number TEXT,
    amount_cents INTEGER NOT NULL,
    check_date TEXT NOT NULL,
    department_name TEXT,
    contract_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL
  ) STRICT;

  CREATE INDEX payments_by_workspace ON payments (workspace_id, id);
`;

const PAYMENT_COLUMNS =
  'id, voucher_number, amount_cents, check_date, department_name, contract_number, vendor_name';

type Row = Record<string, SQLOutputValue>;

export type CreateWorkspaceResult =
  | { readonly ok: true; readonly workspace: Workspace }
  | { readonly ok: false; readonly reason: 'duplicate-slug' };

export interface LedgerStore {
  listWorkspaces(): WorkspaceSummary[];
  findWorkspace(slug: string): Workspace | undefined;
  createWorkspace(input: { readonly slug: string; readonly name: string }): CreateWorkspaceResult;
  countPayments(workspaceId: number): number;
  listPayments(workspaceId: number, page: { readonly limit: number; readonly offset: number }): Payment[];
  allPayments(workspaceId: number): Iterable<Payment>;
  /** Inserts every payment in one transaction: either all rows land or none do. */
  insertPayments(workspaceId: number, payments: readonly NewPayment[]): number;
  close(): void;
}

export function openLedgerStore(dataDir: string): LedgerStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  const prepare = (sql: string): StatementSync => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  };

  const listWorkspaces = prepare(`
    SELECT w.id, w.slug, w.name, w.created_at, COUNT(p.id) AS record_count
    FROM workspaces w
    LEFT JOIN payments p ON p.workspace_id = w.id
    GROUP BY w.id
    ORDER BY w.id
  `);
  const findWorkspace = prepare('SELECT id, slug, name, created_at FROM workspaces WHERE slug = ?');
  const insertWorkspace = prepare(
    'INSERT INTO workspaces (slug, name, created_at) VALUES (?, ?, ?) RETURNING id, slug, name, created_at',
  );
  const countPayments = prepare('SELECT COUNT(*) AS total FROM payments WHERE workspace_id = ?');
  const pagePayments = prepare(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE workspace_id = ? ORDER BY id LIMIT ? OFFSET ?`,
  );
  const allPayments = prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE workspace_id = ? ORDER BY id`);
  const insertPayment = prepare(`
    INSERT INTO payments
      (workspace_id, voucher_number, amount_cents, check_date, department_name, contract_number, vendor_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    listWorkspaces: () =>
      listWorkspaces.all().map((row) => ({ ...toWorkspace(row), recordCount: integer(row, 'record_count') })),

    findWorkspace: (slug) => {
      const row = findWorkspace.get(slug);
      return row === undefined ? undefined : toWorkspace(row);
    },

    createWorkspace: ({ slug, name }) => {
      try {
        const row = insertWorkspace.get(slug, name, new Date().toISOString());
        if (row === undefined) {
          throw new Error('INSERT ... RETURNING produced no row');
        }
        return { ok: true, workspace: toWorkspace(row) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'duplicate-slug' };
        }
        throw error;
      }
    },

    countPayments: (workspaceId) => {
      const row = countPayments.get(workspaceId);
      return row === undefined ? 0 : integer(row, 'total');
    },

    listPayments: (workspaceId, { limit, offset }) =>
      pagePayments.all(workspaceId, limit, offset).map(toPayment),

    *allPayments(workspaceId) {
      for (const row of allPayments.iterate(workspaceId)) {
        yield toPayment(row);
      }
    },

    insertPayments: (workspaceId, payments) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const payment of payments) {
          insertPayment.run(
            workspaceId,
            payment.voucherNumber,
            payment.amountCents,
            payment.checkDate,
            payment.departmentName,
            payment.contractNumber,
            payment.vendorName,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) {
          db.exec('ROLLBACK');
        }
        throw error;
      }
      return payments.length;
    },

    close: () => db.close(),
  };
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get();
  const version = row === undefined ? 0 : Number(row.user_version);
  if (version === SCHEMA_VERSION) {
    return;
  }
  if (version !== 0) {
    throw new Error(`Unsupported database schema version ${version}; expected ${SCHEMA_VERSION}`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function toWorkspace(row: Row): Workspace {
  return {
    id: integer(row, 'id'),
    slug: text(row, 'slug'),
    name: text(row, 'name'),
    createdAt: text(row, 'created_at'),
  };
}

function toPayment(row: Row): Payment {
  return {
    id: integer(row, 'id'),
    voucherNumber: nullableText(row, 'voucher_number'),
    amountCents: bigInteger(row, 'amount_cents'),
    checkDate: text(row, 'check_date'),
    departmentName: nullableText(row, 'department_name'),
    contractNumber: text(row, 'contract_number'),
    vendorName: text(row, 'vendor_name'),
  };
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Expected text in column ${column}`);
  }
  return value;
}

function nullableText(row: Row, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function bigInteger(row: Row, column: string): bigint {
  const value = row[column];
  if (typeof value !== 'bigint') {
    throw new TypeError(`Expected an integer in column ${column}`);
  }
  return value;
}

function integer(row: Row, column: string): number {
  const value = bigInteger(row, column);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Column ${column} exceeds the safe integer range`);
  }
  return Number(value);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'errcode' in error && error.errcode === SQLITE_CONSTRAINT_UNIQUE;
}
