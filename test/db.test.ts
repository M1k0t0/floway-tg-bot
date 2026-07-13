import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { BindingStore } from '../src/db.js';

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

const PRIMARY_STATE_TABLE = 'primary_window_state';
const PRIMARY_NOTIFICATION_TABLE = 'primary_window_notification';

const stateTableSql = (name: string, includeBucket = true): string => `
  CREATE TABLE "${name}" (
    telegram_user_id TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    window_start_at TEXT NOT NULL,
    reset_after_at TEXT NOT NULL,
    used_percent REAL,
    ${includeBucket ? 'quota_bucket_key TEXT,' : ''}
    updated_at TEXT NOT NULL,
    PRIMARY KEY (telegram_user_id, upstream_id)
  )
`;

const notificationTableSql = (name: string): string => `
  CREATE TABLE "${name}" (
    telegram_user_id TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    window_start_at TEXT NOT NULL,
    reset_after_at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (telegram_user_id, upstream_id, window_start_at, reset_after_at)
  )
`;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('BindingStore primary-window schema', () => {
  it('creates current tables for a fresh database', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const store = new BindingStore(dbPath, secretKey);
    stores.push(store);

    store.upsertPrimaryWindowState({
      telegramUserId: '100',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-01T00:00:00.000Z',
      resetAfterAt: '2026-06-08T00:00:00.000Z',
      usedPercent: 42,
      quotaBucketKey: 'premium',
    });
    store.upsertPrimaryWindowNotification({
      telegramUserId: '100',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-01T00:00:00.000Z',
      resetAfterAt: '2026-06-08T00:00:00.000Z',
    });

    expect(store.getPrimaryWindowState('100', 'up_a')).toMatchObject({
      usedPercent: 42,
      quotaBucketKey: 'premium',
    });
    expect(store.getPrimaryWindowNotification(
      '100',
      'up_a',
      '2026-06-01T00:00:00.000Z',
      '2026-06-08T00:00:00.000Z',
    )).not.toBeNull();
  });

  it('renames structurally matching populated tables and preserves every value', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const db = new DatabaseSync(dbPath);
    db.exec(stateTableSql('archive_alpha'));
    db.exec(notificationTableSql('archive_beta'));
    db.prepare(`
      INSERT INTO archive_alpha
        (telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, quota_bucket_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('100', 'up_a', '2026-06-01T00:00:00.123Z', '2026-06-08T00:00:00.456Z', 73.5, 'premium', '2026-06-07T23:59:00.000Z');
    db.prepare(`
      INSERT INTO archive_beta
        (telegram_user_id, upstream_id, window_start_at, reset_after_at, sent_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('100', 'up_a', '2026-05-25T00:00:00.123Z', '2026-06-01T00:00:00.456Z', '2026-06-01T00:01:00.000Z');
    db.close();

    const store = new BindingStore(dbPath, secretKey);
    stores.push(store);

    expect(store.getPrimaryWindowState('100', 'up_a')).toEqual({
      telegramUserId: '100',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-01T00:00:00.123Z',
      resetAfterAt: '2026-06-08T00:00:00.456Z',
      usedPercent: 73.5,
      quotaBucketKey: 'premium',
      updatedAt: '2026-06-07T23:59:00.000Z',
    });
    expect(store.getPrimaryWindowNotification(
      '100',
      'up_a',
      '2026-05-25T00:00:00.123Z',
      '2026-06-01T00:00:00.456Z',
    )).toMatchObject({ sentAt: '2026-06-01T00:01:00.000Z' });
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining([PRIMARY_STATE_TABLE, PRIMARY_NOTIFICATION_TABLE]));
    expect(tableNames(dbPath)).not.toEqual(expect.arrayContaining(['archive_alpha', 'archive_beta']));
  });

  it('upgrades a matching older state schema with a nullable bucket key', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const db = new DatabaseSync(dbPath);
    db.exec(stateTableSql('archive_gamma', false));
    db.prepare(`
      INSERT INTO archive_gamma
        (telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('200', 'up_b', '2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z', 18, '2026-06-02T00:00:00.000Z');
    db.close();

    const store = new BindingStore(dbPath, secretKey);
    stores.push(store);

    expect(store.getPrimaryWindowState('200', 'up_b')).toMatchObject({
      usedPercent: 18,
      quotaBucketKey: null,
    });
    expect(tableColumns(dbPath, PRIMARY_STATE_TABLE)).toContain('quota_bucket_key');
  });

  it('reopens an already migrated database idempotently', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const db = new DatabaseSync(dbPath);
    db.exec(stateTableSql('archive_delta'));
    db.exec(notificationTableSql('archive_epsilon'));
    db.close();

    const first = new BindingStore(dbPath, secretKey);
    first.upsertPrimaryWindowState({
      telegramUserId: '300',
      upstreamId: 'up_c',
      windowStartAt: '2026-06-01T00:00:00.000Z',
      resetAfterAt: '2026-06-08T00:00:00.000Z',
      usedPercent: 9,
      quotaBucketKey: 'premium',
    });
    first.close();

    const reopened = new BindingStore(dbPath, secretKey);
    stores.push(reopened);
    expect(reopened.getPrimaryWindowState('300', 'up_c')).toMatchObject({
      usedPercent: 9,
      quotaBucketKey: 'premium',
    });
    expect(tableNames(dbPath).filter(name => name.startsWith('primary_window_'))).toHaveLength(2);
  });

  it('fails closed and rolls back when matching source tables are ambiguous', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const db = new DatabaseSync(dbPath);
    db.exec(stateTableSql('archive_zeta'));
    db.exec(stateTableSql('archive_eta'));
    db.prepare(`
      INSERT INTO archive_zeta
        (telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, quota_bucket_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('400', 'up_d', '2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z', 1, null, '2026-06-01T00:00:00.000Z');
    db.close();

    expect(() => new BindingStore(dbPath, secretKey)).toThrow('Ambiguous quota-window table migration');
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining(['archive_zeta', 'archive_eta']));
    expect(tableNames(dbPath)).not.toContain(PRIMARY_STATE_TABLE);
    expect(rowCount(dbPath, 'archive_zeta')).toBe(1);
  });
});

const createDatabasePath = (): { dbPath: string; secretKey: Buffer } => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-db-test-'));
  tempDirs.push(dir);
  return { dbPath: join(dir, 'bot.sqlite'), secretKey: randomBytes(32) };
};

const tableNames = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as unknown as Array<{ name: string }>;
  db.close();
  return rows.map(row => row.name);
};

const tableColumns = (dbPath: string, table: string): string[] => {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>;
  db.close();
  return rows.map(row => row.name);
};

const rowCount = (dbPath: string, table: string): number => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
  db.close();
  return row.count;
};
