import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { MAX_DELIVERY_ERROR_LENGTH, MAX_TIMESTAMP_MS } from '../db-constraints.js';
import type { DatabaseMigration } from './types.js';

const LEGACY_BINDING_COLUMNS: readonly ColumnSignature[] = [
  { name: 'telegram_user_id', type: 'TEXT', notnull: 0, pk: 1 },
  { name: 'floway_user_id', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'username', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'encrypted_session', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'session_nonce', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
];

const TABLE_NAMES = ['bindings', 'primary_window_cursor', 'primary_window_event', 'primary_window_delivery'] as const;
const SCHEMA_OBJECT_NAMES = [
  ...TABLE_NAMES,
  'primary_window_delivery_claim_idx',
  'primary_window_delivery_lease_idx',
  'primary_window_delivery_claim_token_idx',
  'primary_window_delivery_event_fk_idx',
  'primary_window_delivery_binding_fk_idx',
  'primary_window_event_retention_idx',
] as const;
const TEMPORARY_BINDINGS_TABLE = '__bindings_v0_migration';

interface ColumnSignature {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

type TableInfoRow = ColumnSignature;

interface TableListRow {
  name: string;
  wr: number;
  strict: number;
}

interface SchemaObjectRow {
  name: string;
  sql: string | null;
}

interface LegacyBindingRow {
  telegram_user_id: unknown;
  floway_user_id: unknown;
  username: unknown;
  encrypted_session: unknown;
  session_nonce: unknown;
}

export const initializeDatabaseMigration: DatabaseMigration = {
  version: 1,
  name: 'initialize',
  up(db, { nowMs }) {
    const existingTables = tableNames(db);
    const conflictingTable = TABLE_NAMES.find(name => name !== 'bindings' && existingTables.includes(name));
    if (conflictingTable) throw new Error(`Version-0 database unexpectedly contains ${conflictingTable}`);

    const legacyRows = existingTables.includes('bindings') ? readLegacyBindings(db) : [];
    if (existingTables.includes('bindings')) {
      if (existingTables.includes(TEMPORARY_BINDINGS_TABLE)) throw new Error('Reserved migration table already exists');
      db.exec(`ALTER TABLE bindings RENAME TO ${quoteIdentifier(TEMPORARY_BINDINGS_TABLE)}`);
    }

    createVersionOneSchema(db);
    if (legacyRows.length > 0) {
      const insert = db.prepare(`
        INSERT INTO bindings (
          telegram_user_id, floway_user_id, username, encrypted_session, session_nonce,
          bound_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        insert.run(
          row.telegram_user_id as SQLInputValue,
          row.floway_user_id as SQLInputValue,
          row.username as SQLInputValue,
          row.encrypted_session as SQLInputValue,
          row.session_nonce as SQLInputValue,
          nowMs,
          nowMs,
        );
      }
    }
    verifyMigratedBindings(db, legacyRows, nowMs);
    if (existingTables.includes('bindings')) db.exec(`DROP TABLE ${quoteIdentifier(TEMPORARY_BINDINGS_TABLE)}`);
  },
  verify: verifyVersionOneSchema,
};

export function verifyVersionOneSchema(db: DatabaseSync): void {
  const existingTables = tableNames(db);
  for (const table of TABLE_NAMES) {
    if (!existingTables.includes(table)) throw new Error(`Required table ${table} is missing`);
    if (!hasTableFlags(db, table, 0, 1)) throw new Error(`Required table ${table} is not STRICT`);
  }

  if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('Database contains foreign-key violations');
  }
  const deliveryForeignKeys = db.prepare('PRAGMA foreign_key_list(primary_window_delivery)').all() as unknown as Array<{ table: unknown; on_delete: unknown }>;
  if (!deliveryForeignKeys.some(row => row.table === 'bindings' && row.on_delete === 'CASCADE')
    || !deliveryForeignKeys.some(row => row.table === 'primary_window_event' && row.on_delete === 'CASCADE')) {
    throw new Error('Delivery foreign keys do not match the current schema');
  }
  if (schemaManifest(db) !== expectedVersionOneSchemaManifest()) {
    throw new Error('Database schema does not match the current definition');
  }
}

const readLegacyBindings = (db: DatabaseSync): LegacyBindingRow[] => {
  if (!schemaMatches(tableInfo(db, 'bindings'), LEGACY_BINDING_COLUMNS) || !hasTableFlags(db, 'bindings', 0, 0)) {
    throw new Error('Version-0 bindings table does not match the shipped schema');
  }
  return db.prepare(`
    SELECT telegram_user_id, floway_user_id, username, encrypted_session, session_nonce
    FROM bindings ORDER BY telegram_user_id
  `).all() as unknown as LegacyBindingRow[];
};

const verifyMigratedBindings = (db: DatabaseSync, before: readonly LegacyBindingRow[], nowMs: number): void => {
  const after = db.prepare(`
    SELECT telegram_user_id, floway_user_id, username, encrypted_session, session_nonce,
           bound_at_ms, updated_at_ms
    FROM bindings ORDER BY telegram_user_id
  `).all() as unknown as Array<LegacyBindingRow & { bound_at_ms: unknown; updated_at_ms: unknown }>;
  if (before.length !== after.length) throw new Error('Binding row count changed during migration');
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (!left || !right
      || !Object.is(left.telegram_user_id, right.telegram_user_id)
      || !Object.is(left.floway_user_id, right.floway_user_id)
      || !Object.is(left.username, right.username)
      || !Object.is(left.encrypted_session, right.encrypted_session)
      || !Object.is(left.session_nonce, right.session_nonce)
      || right.bound_at_ms !== nowMs
      || right.updated_at_ms !== nowMs) {
      throw new Error('Binding values changed during migration');
    }
  }
};

const createVersionOneSchema = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL UNIQUE CHECK (length(telegram_user_id) > 0),
      floway_user_id INTEGER NOT NULL CHECK (floway_user_id > 0 AND floway_user_id <= 9007199254740991),
      username TEXT NOT NULL CHECK (length(username) > 0),
      encrypted_session TEXT NOT NULL CHECK (length(encrypted_session) > 0),
      session_nonce TEXT NOT NULL CHECK (length(session_nonce) > 0),
      bound_at_ms INTEGER NOT NULL CHECK (bound_at_ms >= 0 AND bound_at_ms <= ${MAX_TIMESTAMP_MS}),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= bound_at_ms AND updated_at_ms <= ${MAX_TIMESTAMP_MS})
    ) STRICT;

    CREATE TABLE primary_window_cursor (
      upstream_id TEXT PRIMARY KEY CHECK (length(upstream_id) > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
      anchor_start_at_ms INTEGER NOT NULL,
      anchor_end_at_ms INTEGER NOT NULL,
      anchor_duration_ms INTEGER NOT NULL,
      anchor_observed_at_ms INTEGER NOT NULL,
      latest_start_at_ms INTEGER NOT NULL,
      latest_end_at_ms INTEGER NOT NULL,
      latest_duration_ms INTEGER NOT NULL,
      latest_observed_at_ms INTEGER NOT NULL,
      latest_used_percent REAL,
      latest_quota_bucket_key TEXT,
      latest_active_limit TEXT,
      pending_kind TEXT,
      pending_start_at_ms INTEGER,
      pending_end_at_ms INTEGER,
      pending_duration_ms INTEGER,
      pending_observed_at_ms INTEGER,
      pending_first_seen_at_ms INTEGER,
      pending_observation_count INTEGER,
      CHECK (${windowCheckSql('anchor')}),
      CHECK (${windowCheckSql('latest')}),
      CHECK (latest_used_percent IS NULL OR (latest_used_percent >= 0 AND latest_used_percent <= 100)),
      CHECK (latest_quota_bucket_key IS NULL OR length(latest_quota_bucket_key) > 0),
      CHECK (latest_active_limit IS NULL OR length(latest_active_limit) > 0),
      CHECK (
        (pending_kind IS NULL AND pending_start_at_ms IS NULL AND pending_end_at_ms IS NULL
          AND pending_duration_ms IS NULL AND pending_observed_at_ms IS NULL
          AND pending_first_seen_at_ms IS NULL AND pending_observation_count IS NULL)
        OR
        (pending_kind IN ('natural', 'manual') AND pending_start_at_ms IS NOT NULL
          AND pending_end_at_ms IS NOT NULL AND pending_duration_ms IS NOT NULL
          AND pending_observed_at_ms IS NOT NULL AND pending_first_seen_at_ms IS NOT NULL
          AND pending_observation_count IS NOT NULL AND pending_observation_count > 0
          AND pending_start_at_ms >= 0 AND pending_end_at_ms > pending_start_at_ms
          AND pending_duration_ms = pending_end_at_ms - pending_start_at_ms
          AND pending_observed_at_ms >= 0 AND pending_first_seen_at_ms >= 0
          AND pending_end_at_ms <= ${MAX_TIMESTAMP_MS}
          AND pending_observed_at_ms <= ${MAX_TIMESTAMP_MS}
          AND pending_first_seen_at_ms <= ${MAX_TIMESTAMP_MS})
      )
    ) STRICT;

    CREATE TABLE primary_window_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upstream_id TEXT NOT NULL,
      from_revision INTEGER NOT NULL CHECK (from_revision >= 0 AND from_revision <= 9007199254740990),
      to_revision INTEGER NOT NULL CHECK (to_revision = from_revision + 1),
      upstream_kind TEXT NOT NULL CHECK (length(upstream_kind) > 0),
      upstream_name TEXT NOT NULL CHECK (length(upstream_name) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('natural', 'manual')),
      previous_start_at_ms INTEGER NOT NULL,
      previous_end_at_ms INTEGER NOT NULL,
      previous_duration_ms INTEGER NOT NULL,
      previous_observed_at_ms INTEGER NOT NULL,
      previous_used_percent REAL,
      previous_quota_bucket_key TEXT,
      previous_active_limit TEXT,
      current_start_at_ms INTEGER NOT NULL,
      current_end_at_ms INTEGER NOT NULL,
      current_duration_ms INTEGER NOT NULL,
      current_observed_at_ms INTEGER NOT NULL,
      current_used_percent REAL,
      current_quota_bucket_key TEXT,
      current_active_limit TEXT,
      detected_at_ms INTEGER NOT NULL CHECK (detected_at_ms >= 0 AND detected_at_ms <= ${MAX_TIMESTAMP_MS}),
      effective_previous_usage_end_at_ms INTEGER,
      UNIQUE (upstream_id, to_revision),
      FOREIGN KEY (upstream_id) REFERENCES primary_window_cursor(upstream_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      CHECK (${windowCheckSql('previous')}),
      CHECK (${windowCheckSql('current')}),
      CHECK (previous_used_percent IS NULL OR (previous_used_percent >= 0 AND previous_used_percent <= 100)),
      CHECK (current_used_percent IS NULL OR (current_used_percent >= 0 AND current_used_percent <= 100)),
      CHECK (previous_quota_bucket_key IS NULL OR length(previous_quota_bucket_key) > 0),
      CHECK (current_quota_bucket_key IS NULL OR length(current_quota_bucket_key) > 0),
      CHECK (previous_active_limit IS NULL OR length(previous_active_limit) > 0),
      CHECK (current_active_limit IS NULL OR length(current_active_limit) > 0),
      CHECK (
        (kind = 'natural' AND effective_previous_usage_end_at_ms IS NULL)
        OR
        (kind = 'manual' AND effective_previous_usage_end_at_ms IS NOT NULL
          AND effective_previous_usage_end_at_ms >= previous_start_at_ms
          AND effective_previous_usage_end_at_ms <= previous_end_at_ms)
      )
    ) STRICT;

    CREATE TABLE primary_window_delivery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES primary_window_event(id) ON UPDATE RESTRICT ON DELETE CASCADE,
      binding_id INTEGER NOT NULL REFERENCES bindings(id) ON UPDATE RESTRICT ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'sent', 'skipped', 'dead')),
      payload TEXT CHECK (payload IS NULL OR length(payload) > 0),
      attempts INTEGER NOT NULL CHECK (attempts >= 0 AND attempts <= 9007199254740991),
      next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0 AND next_attempt_at_ms <= ${MAX_TIMESTAMP_MS}),
      claim_token TEXT,
      claim_until_ms INTEGER,
      sent_at_ms INTEGER,
      dead_at_ms INTEGER,
      last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= ${MAX_DELIVERY_ERROR_LENGTH}),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= ${MAX_TIMESTAMP_MS}),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= ${MAX_TIMESTAMP_MS}),
      UNIQUE (event_id, binding_id),
      CHECK (
        (status = 'pending' AND claim_token IS NULL AND claim_until_ms IS NULL AND sent_at_ms IS NULL AND dead_at_ms IS NULL)
        OR
        (status = 'leased' AND claim_token IS NOT NULL AND length(claim_token) > 0
          AND claim_until_ms IS NOT NULL AND claim_until_ms >= updated_at_ms
          AND sent_at_ms IS NULL AND dead_at_ms IS NULL)
        OR
        (status = 'sent' AND payload IS NOT NULL AND claim_token IS NULL AND claim_until_ms IS NULL
          AND sent_at_ms IS NOT NULL AND sent_at_ms >= created_at_ms AND dead_at_ms IS NULL)
        OR
        (status = 'skipped' AND claim_token IS NULL AND claim_until_ms IS NULL
          AND sent_at_ms IS NULL AND dead_at_ms IS NULL)
        OR
        (status = 'dead' AND claim_token IS NULL AND claim_until_ms IS NULL
          AND sent_at_ms IS NULL AND dead_at_ms IS NOT NULL AND dead_at_ms >= created_at_ms)
      )
    ) STRICT;

    CREATE INDEX primary_window_delivery_claim_idx
      ON primary_window_delivery(status, next_attempt_at_ms, id);
    CREATE INDEX primary_window_delivery_lease_idx
      ON primary_window_delivery(status, claim_until_ms, id);
    CREATE UNIQUE INDEX primary_window_delivery_claim_token_idx
      ON primary_window_delivery(claim_token) WHERE claim_token IS NOT NULL;
    CREATE INDEX primary_window_delivery_event_fk_idx
      ON primary_window_delivery(event_id);
    CREATE INDEX primary_window_delivery_binding_fk_idx
      ON primary_window_delivery(binding_id);
    CREATE INDEX primary_window_event_retention_idx
      ON primary_window_event(detected_at_ms, id);
  `);
};

const windowCheckSql = (prefix: string): string => `
  ${prefix}_start_at_ms >= 0
  AND ${prefix}_end_at_ms > ${prefix}_start_at_ms
  AND ${prefix}_duration_ms = ${prefix}_end_at_ms - ${prefix}_start_at_ms
  AND ${prefix}_observed_at_ms >= 0
  AND ${prefix}_end_at_ms <= ${MAX_TIMESTAMP_MS}
  AND ${prefix}_observed_at_ms <= ${MAX_TIMESTAMP_MS}
`;

const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as unknown as Array<{ name: string }>)
    .map(row => row.name);

const tableInfo = (db: DatabaseSync, table: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as TableInfoRow[];

const hasTableFlags = (db: DatabaseSync, table: string, withoutRowId: number, strict: number): boolean => {
  const row = (db.prepare('PRAGMA table_list').all() as unknown as TableListRow[]).find(candidate => candidate.name === table);
  return row?.wr === withoutRowId && row.strict === strict;
};

const schemaMatches = (actual: readonly TableInfoRow[], expected: readonly ColumnSignature[]): boolean =>
  actual.length === expected.length
  && actual.every((column, index) => {
    const signature = expected[index];
    return signature !== undefined
      && column.name === signature.name
      && column.type.toUpperCase() === signature.type
      && column.notnull === signature.notnull
      && column.pk === signature.pk;
  });

const schemaManifest = (db: DatabaseSync): string => {
  const placeholders = SCHEMA_OBJECT_NAMES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE name IN (${placeholders})
    ORDER BY name
  `).all(...SCHEMA_OBJECT_NAMES) as unknown as SchemaObjectRow[];
  if (rows.length !== SCHEMA_OBJECT_NAMES.length || rows.some(row => typeof row.sql !== 'string')) {
    throw new Error('Database schema objects are incomplete');
  }
  return JSON.stringify(rows.map(row => [row.name, row.sql]));
};

let expectedSchemaManifest: string | null = null;

const expectedVersionOneSchemaManifest = (): string => {
  if (expectedSchemaManifest !== null) return expectedSchemaManifest;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    createVersionOneSchema(db);
    expectedSchemaManifest = schemaManifest(db);
    return expectedSchemaManifest;
  } finally {
    db.close();
  }
};

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;
