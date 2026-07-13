import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { decryptString, encryptString } from './crypto.js';
import type { Binding } from './types.js';

interface BindingRow {
  telegram_user_id: string;
  floway_user_id: number;
  username: string;
  encrypted_session: string;
  session_nonce: string;
  created_at: string;
  updated_at: string;
}

interface PrimaryWindowStateRow {
  telegram_user_id: string;
  upstream_id: string;
  window_start_at: string;
  reset_after_at: string;
  used_percent: number | null;
  quota_bucket_key: string | null;
  updated_at: string;
}

interface PrimaryWindowNotificationRow {
  telegram_user_id: string;
  upstream_id: string;
  window_start_at: string;
  reset_after_at: string;
  sent_at: string;
}

interface SchemaTableRow {
  name: string;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ColumnSignature {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

export interface PrimaryWindowState {
  telegramUserId: string;
  upstreamId: string;
  windowStartAt: string;
  resetAfterAt: string;
  usedPercent: number | null;
  quotaBucketKey: string | null;
  updatedAt: string;
}

export interface PrimaryWindowNotification {
  telegramUserId: string;
  upstreamId: string;
  windowStartAt: string;
  resetAfterAt: string;
  sentAt: string;
}

const PRIMARY_STATE_TABLE = 'primary_window_state';
const PRIMARY_NOTIFICATION_TABLE = 'primary_window_notification';

const STATE_COLUMNS: readonly ColumnSignature[] = [
  { name: 'telegram_user_id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'upstream_id', type: 'TEXT', notnull: 1, pk: 2 },
  { name: 'window_start_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'reset_after_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'used_percent', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'quota_bucket_key', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
];

const LEGACY_STATE_COLUMNS = STATE_COLUMNS.filter(column => column.name !== 'quota_bucket_key');

const NOTIFICATION_COLUMNS: readonly ColumnSignature[] = [
  { name: 'telegram_user_id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'upstream_id', type: 'TEXT', notnull: 1, pk: 2 },
  { name: 'window_start_at', type: 'TEXT', notnull: 1, pk: 3 },
  { name: 'reset_after_at', type: 'TEXT', notnull: 1, pk: 4 },
  { name: 'sent_at', type: 'TEXT', notnull: 1, pk: 0 },
];

export class BindingStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly secretKey: Buffer,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bindings (
          telegram_user_id TEXT PRIMARY KEY,
          floway_user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          encrypted_session TEXT NOT NULL,
          session_nonce TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.migratePrimaryWindowTables();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  list(): Binding[] {
    const rows = this.db
      .prepare('SELECT telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, created_at, updated_at FROM bindings ORDER BY telegram_user_id')
      .all() as unknown as BindingRow[];
    return rows.map(row => this.bindingFromRow(row));
  }

  get(telegramUserId: string): Binding | null {
    const row = this.db
      .prepare('SELECT telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, created_at, updated_at FROM bindings WHERE telegram_user_id = ?')
      .get(telegramUserId) as BindingRow | undefined;
    if (!row) return null;
    return this.bindingFromRow(row);
  }

  upsert(input: { telegramUserId: string; flowayUserId: number; username: string; flowaySession: string }): Binding {
    const now = new Date().toISOString();
    const encrypted = encryptString(input.flowaySession, this.secretKey);
    const existing = this.db
      .prepare('SELECT created_at FROM bindings WHERE telegram_user_id = ?')
      .get(input.telegramUserId) as { created_at: string } | undefined;
    const createdAt = existing?.created_at ?? now;
    this.db
      .prepare(`
        INSERT INTO bindings (telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (telegram_user_id) DO UPDATE SET
          floway_user_id = excluded.floway_user_id,
          username = excluded.username,
          encrypted_session = excluded.encrypted_session,
          session_nonce = excluded.session_nonce,
          updated_at = excluded.updated_at
      `)
      .run(input.telegramUserId, input.flowayUserId, input.username, encrypted.ciphertext, encrypted.nonce, createdAt, now);
    return {
      telegramUserId: input.telegramUserId,
      flowayUserId: input.flowayUserId,
      username: input.username,
      flowaySession: input.flowaySession,
      createdAt,
      updatedAt: now,
    };
  }

  delete(telegramUserId: string): boolean {
    this.db.prepare(`DELETE FROM ${PRIMARY_NOTIFICATION_TABLE} WHERE telegram_user_id = ?`).run(telegramUserId);
    this.db.prepare(`DELETE FROM ${PRIMARY_STATE_TABLE} WHERE telegram_user_id = ?`).run(telegramUserId);
    const result = this.db.prepare('DELETE FROM bindings WHERE telegram_user_id = ?').run(telegramUserId);
    return result.changes > 0;
  }

  getPrimaryWindowState(telegramUserId: string, upstreamId: string): PrimaryWindowState | null {
    const row = this.db
      .prepare(`SELECT telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, quota_bucket_key, updated_at FROM ${PRIMARY_STATE_TABLE} WHERE telegram_user_id = ? AND upstream_id = ?`)
      .get(telegramUserId, upstreamId) as PrimaryWindowStateRow | undefined;
    return row ? primaryWindowStateFromRow(row) : null;
  }

  upsertPrimaryWindowState(input: Omit<PrimaryWindowState, 'updatedAt'>): PrimaryWindowState {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO ${PRIMARY_STATE_TABLE} (telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, quota_bucket_key, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (telegram_user_id, upstream_id) DO UPDATE SET
          window_start_at = excluded.window_start_at,
          reset_after_at = excluded.reset_after_at,
          used_percent = excluded.used_percent,
          quota_bucket_key = excluded.quota_bucket_key,
          updated_at = excluded.updated_at
      `)
      .run(input.telegramUserId, input.upstreamId, input.windowStartAt, input.resetAfterAt, input.usedPercent, input.quotaBucketKey, now);
    return { ...input, updatedAt: now };
  }

  deletePrimaryWindowState(telegramUserId: string, upstreamId: string): void {
    this.db
      .prepare(`DELETE FROM ${PRIMARY_STATE_TABLE} WHERE telegram_user_id = ? AND upstream_id = ?`)
      .run(telegramUserId, upstreamId);
  }

  deletePrimaryWindowStatesExcept(telegramUserId: string, upstreamIds: readonly string[]): void {
    if (upstreamIds.length === 0) {
      this.db.prepare(`DELETE FROM ${PRIMARY_STATE_TABLE} WHERE telegram_user_id = ?`).run(telegramUserId);
      return;
    }
    const placeholders = upstreamIds.map(() => '?').join(', ');
    this.db
      .prepare(`DELETE FROM ${PRIMARY_STATE_TABLE} WHERE telegram_user_id = ? AND upstream_id NOT IN (${placeholders})`)
      .run(telegramUserId, ...upstreamIds);
  }

  getPrimaryWindowNotification(
    telegramUserId: string,
    upstreamId: string,
    windowStartAt: string,
    resetAfterAt: string,
  ): PrimaryWindowNotification | null {
    const row = this.db
      .prepare(`
        SELECT telegram_user_id, upstream_id, window_start_at, reset_after_at, sent_at
        FROM ${PRIMARY_NOTIFICATION_TABLE}
        WHERE telegram_user_id = ? AND upstream_id = ? AND window_start_at = ? AND reset_after_at = ?
      `)
      .get(telegramUserId, upstreamId, windowStartAt, resetAfterAt) as PrimaryWindowNotificationRow | undefined;
    return row ? primaryWindowNotificationFromRow(row) : null;
  }

  getPrimaryWindowNotificationByHour(
    telegramUserId: string,
    upstreamId: string,
    windowStartHour: string,
    resetAfterHour: string,
  ): PrimaryWindowNotification | null {
    const row = this.db
      .prepare(`
        SELECT telegram_user_id, upstream_id, window_start_at, reset_after_at, sent_at
        FROM ${PRIMARY_NOTIFICATION_TABLE}
        WHERE telegram_user_id = ?
          AND upstream_id = ?
          AND substr(window_start_at, 1, 13) = ?
          AND substr(reset_after_at, 1, 13) = ?
        ORDER BY sent_at DESC
        LIMIT 1
      `)
      .get(telegramUserId, upstreamId, windowStartHour, resetAfterHour) as PrimaryWindowNotificationRow | undefined;
    return row ? primaryWindowNotificationFromRow(row) : null;
  }

  getPrimaryWindowNotificationEndingByHour(
    telegramUserId: string,
    upstreamId: string,
    resetAfterHour: string,
  ): PrimaryWindowNotification | null {
    const row = this.db
      .prepare(`
        SELECT telegram_user_id, upstream_id, window_start_at, reset_after_at, sent_at
        FROM ${PRIMARY_NOTIFICATION_TABLE}
        WHERE telegram_user_id = ?
          AND upstream_id = ?
          AND substr(reset_after_at, 1, 13) = ?
        ORDER BY sent_at DESC
        LIMIT 1
      `)
      .get(telegramUserId, upstreamId, resetAfterHour) as PrimaryWindowNotificationRow | undefined;
    return row ? primaryWindowNotificationFromRow(row) : null;
  }

  upsertPrimaryWindowNotification(input: Omit<PrimaryWindowNotification, 'sentAt'>): PrimaryWindowNotification {
    const sentAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO ${PRIMARY_NOTIFICATION_TABLE} (telegram_user_id, upstream_id, window_start_at, reset_after_at, sent_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (telegram_user_id, upstream_id, window_start_at, reset_after_at) DO UPDATE SET
          sent_at = excluded.sent_at
      `)
      .run(input.telegramUserId, input.upstreamId, input.windowStartAt, input.resetAfterAt, sentAt);
    return { ...input, sentAt };
  }

  close(): void {
    this.db.close();
  }

  private migratePrimaryWindowTables(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.migrateTable(PRIMARY_STATE_TABLE, [STATE_COLUMNS, LEGACY_STATE_COLUMNS], createPrimaryStateTable);
      if (schemaMatches(this.tableInfo(PRIMARY_STATE_TABLE), LEGACY_STATE_COLUMNS)) {
        this.db.exec(`ALTER TABLE ${PRIMARY_STATE_TABLE} ADD COLUMN quota_bucket_key TEXT`);
      }
      this.assertSchema(PRIMARY_STATE_TABLE, STATE_COLUMNS);

      this.migrateTable(PRIMARY_NOTIFICATION_TABLE, [NOTIFICATION_COLUMNS], createPrimaryNotificationTable);
      this.assertSchema(PRIMARY_NOTIFICATION_TABLE, NOTIFICATION_COLUMNS);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateTable(
    target: string,
    candidateSignatures: readonly (readonly ColumnSignature[])[],
    createTable: (db: DatabaseSync) => void,
  ): void {
    const tables = this.tableNames();
    const targetExists = tables.includes(target);
    const excluded = new Set(['bindings', PRIMARY_STATE_TABLE, PRIMARY_NOTIFICATION_TABLE]);
    const candidates = tables.filter(name =>
      !excluded.has(name)
      && !name.startsWith('sqlite_')
      && candidateSignatures.some(signature => schemaMatches(this.tableInfo(name), signature)));

    if (candidates.length > 1 || (targetExists && candidates.length > 0)) {
      throw new Error(`Ambiguous quota-window table migration for ${target}`);
    }
    if (targetExists) return;
    if (candidates.length === 0) {
      createTable(this.db);
      return;
    }

    const source = candidates[0]!;
    const beforeCount = this.rowCount(source);
    this.db.exec(`ALTER TABLE ${quoteIdentifier(source)} RENAME TO ${quoteIdentifier(target)}`);
    const afterCount = this.rowCount(target);
    if (beforeCount !== afterCount) {
      throw new Error(`Quota-window row count changed while migrating ${target}`);
    }
  }

  private tableNames(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as unknown as SchemaTableRow[];
    return rows.map(row => row.name);
  }

  private tableInfo(table: string): TableInfoRow[] {
    return this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as TableInfoRow[];
  }

  private rowCount(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number };
    return row.count;
  }

  private assertSchema(table: string, signature: readonly ColumnSignature[]): void {
    if (!schemaMatches(this.tableInfo(table), signature)) {
      throw new Error(`Unexpected schema for ${table}`);
    }
  }

  private bindingFromRow(row: BindingRow): Binding {
    return {
      telegramUserId: row.telegram_user_id,
      flowayUserId: row.floway_user_id,
      username: row.username,
      flowaySession: decryptString({ ciphertext: row.encrypted_session, nonce: row.session_nonce }, this.secretKey),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

const createPrimaryStateTable = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE ${PRIMARY_STATE_TABLE} (
      telegram_user_id TEXT NOT NULL,
      upstream_id TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      reset_after_at TEXT NOT NULL,
      used_percent REAL,
      quota_bucket_key TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (telegram_user_id, upstream_id)
    )
  `);
};

const createPrimaryNotificationTable = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE ${PRIMARY_NOTIFICATION_TABLE} (
      telegram_user_id TEXT NOT NULL,
      upstream_id TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      reset_after_at TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (telegram_user_id, upstream_id, window_start_at, reset_after_at)
    )
  `);
};

const schemaMatches = (actual: readonly TableInfoRow[], expected: readonly ColumnSignature[]): boolean => {
  if (actual.length !== expected.length) return false;
  const actualByName = new Map(actual.map(column => [column.name, column]));
  return expected.every(signature => {
    const column = actualByName.get(signature.name);
    return column !== undefined
      && column.type.toUpperCase() === signature.type
      && column.notnull === signature.notnull
      && column.pk === signature.pk;
  });
};

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const primaryWindowStateFromRow = (row: PrimaryWindowStateRow): PrimaryWindowState => ({
  telegramUserId: row.telegram_user_id,
  upstreamId: row.upstream_id,
  windowStartAt: row.window_start_at,
  resetAfterAt: row.reset_after_at,
  usedPercent: row.used_percent,
  quotaBucketKey: row.quota_bucket_key,
  updatedAt: row.updated_at,
});

const primaryWindowNotificationFromRow = (row: PrimaryWindowNotificationRow): PrimaryWindowNotification => ({
  telegramUserId: row.telegram_user_id,
  upstreamId: row.upstream_id,
  windowStartAt: row.window_start_at,
  resetAfterAt: row.reset_after_at,
  sentAt: row.sent_at,
});
