import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { encryptString } from '../src/crypto.js';
import { BindingStore, CURRENT_SCHEMA_VERSION } from '../src/db.js';
import { applyMigrationRegistry, validateMigrationRegistry } from '../src/db-migrations/index.js';
import type { DatabaseMigration } from '../src/db-migrations/types.js';

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

const OBSERVED = Date.UTC(2026, 5, 1);

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('automatic database migrations', () => {
  it('automatically creates the current STRICT schema before the store is used', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const store = track(new BindingStore(dbPath, secretKey));

    const db = new DatabaseSync(dbPath);
    expect(pragmaValue(db, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);
    expect(String(pragmaValue(db, 'journal_mode')).toLowerCase()).toBe('wal');
    expect(tableFlags(db)).toMatchObject({
      bindings: 1,
      quota_window_cursor: 1,
      quota_window_event: 1,
      quota_window_delivery: 1,
    });
    expect(indexNames(db)).toEqual(expect.arrayContaining([
      'quota_window_delivery_claim_idx',
      'quota_window_delivery_lease_idx',
      'quota_window_delivery_claim_token_idx',
      'quota_window_delivery_event_fk_idx',
      'quota_window_delivery_binding_fk_idx',
      'quota_window_event_retention_idx',
    ]));
    db.close();
    expect(store.listBindingsSafely()).toEqual({ bindings: [], errors: [], probableWrongSecret: false });
  });

  it('migrates shipped bindings automatically and preserves encrypted values', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const encrypted = encryptString('preserved-session', secretKey);
    const db = new DatabaseSync(dbPath);
    createShippedBindings(db);
    db.prepare(`
      INSERT INTO bindings
        (telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('100', 7, 'alice', encrypted.ciphertext, encrypted.nonce, '2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    db.exec("CREATE TABLE archived_notifier_cache (value TEXT); INSERT INTO archived_notifier_cache VALUES ('keep')");
    db.close();

    const before = Date.now();
    const store = track(new BindingStore(dbPath, secretKey));
    const after = Date.now();
    expect(store.getByTelegramUserId('100')).toMatchObject({
      bindingId: 1,
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'preserved-session',
    });
    const raw = queryOne(dbPath, 'SELECT encrypted_session, session_nonce, bound_at_ms, updated_at_ms FROM bindings');
    expect(raw.encrypted_session).toBe(encrypted.ciphertext);
    expect(raw.session_nonce).toBe(encrypted.nonce);
    expect(raw.bound_at_ms).toBe(raw.updated_at_ms);
    expect(raw.bound_at_ms).toBeGreaterThanOrEqual(before);
    expect(raw.bound_at_ms).toBeLessThanOrEqual(after);
    expect(queryOne(dbPath, 'SELECT value FROM archived_notifier_cache').value).toBe('keep');
    expect(queryOne(dbPath, 'SELECT count(*) AS count FROM quota_window_cursor').count).toBe(0);
    expect(queryOne(dbPath, 'SELECT count(*) AS count FROM quota_window_event').count).toBe(0);
    expect(queryOne(dbPath, 'SELECT count(*) AS count FROM quota_window_delivery').count).toBe(0);
  });

  it('reopens the current version without rerunning migrations', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const first = new BindingStore(dbPath, secretKey);
    const binding = first.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'token' }, OBSERVED);
    first.close();

    const reopened = track(new BindingStore(dbPath, secretKey));
    expect(reopened.getByBindingId(binding.bindingId)?.flowaySession).toBe('token');
    expect(pragmaFromPath(dbPath, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('serializes concurrent startup migration across processes', async () => {
    const { dbPath, secretKey } = createDatabasePath();
    const key = secretKey.toString('base64');
    const script = [
      "import { BindingStore } from './src/db.ts';",
      `const store = new BindingStore(${JSON.stringify(dbPath)}, Buffer.from(${JSON.stringify(key)}, 'base64'));`,
      'store.close();',
    ].join(' ');

    const results = await Promise.all([
      runNodeScript(script),
      runNodeScript(script),
    ]);
    expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    expect(pragmaFromPath(dbPath, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);
    const reopened = track(new BindingStore(dbPath, secretKey));
    expect(reopened.listBindingsSafely()).toEqual({ bindings: [], errors: [], probableWrongSecret: false });
  });

  it('rejects future versions and incompatible version-zero schemas without persistent changes', () => {
    const future = createDatabasePath();
    const futureDb = new DatabaseSync(future.dbPath);
    futureDb.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}; CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep')`);
    futureDb.close();
    expect(() => new BindingStore(future.dbPath, future.secretKey)).toThrow('newer than supported');
    expect(tableNames(future.dbPath)).toEqual(['sentinel']);
    expect(pragmaFromPath(future.dbPath, 'user_version')).toBe(CURRENT_SCHEMA_VERSION + 1);

    const incompatible = createDatabasePath();
    const incompatibleDb = new DatabaseSync(incompatible.dbPath);
    incompatibleDb.exec('CREATE TABLE bindings (telegram_user_id TEXT PRIMARY KEY, wrong TEXT)');
    incompatibleDb.close();
    expect(() => new BindingStore(incompatible.dbPath, incompatible.secretKey)).toThrow('does not match the shipped schema');
    expect(tableNames(incompatible.dbPath)).toEqual(['bindings']);
    expect(pragmaFromPath(incompatible.dbPath, 'user_version')).toBe(0);
  });

  it('rejects current-version schema drift', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const initial = new BindingStore(dbPath, secretKey);
    initial.close();
    const db = new DatabaseSync(dbPath);
    db.exec('ALTER TABLE bindings ADD COLUMN unexpected TEXT');
    db.close();

    expect(() => new BindingStore(dbPath, secretKey)).toThrow('schema does not match');
    expect(pragmaFromPath(dbPath, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('applies every pending registered version in order and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    const applied: number[] = [];
    const registry = [1, 2, 3].map(version => migration(version, applied));

    applyMigrationRegistry(db, registry);
    expect(applied).toEqual([1, 2, 3]);
    expect(pragmaValue(db, 'user_version')).toBe(3);
    applyMigrationRegistry(db, registry);
    expect(applied).toEqual([1, 2, 3]);
    db.close();
  });

  it('rolls back a failed pending migration and leaves its version unapplied', () => {
    const db = new DatabaseSync(':memory:');
    const registry: DatabaseMigration[] = [
      migration(1, []),
      {
        version: 2,
        name: 'fails',
        up(database) {
          database.exec('CREATE TABLE partial_change (value TEXT)');
          throw new Error('migration failed');
        },
        verify() {},
      },
    ];

    expect(() => applyMigrationRegistry(db, registry)).toThrow('migration failed');
    expect(pragmaValue(db, 'user_version')).toBe(1);
    expect((db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'partial_change'").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it('rejects migration registries with gaps, duplicates, or empty names', () => {
    expect(() => validateMigrationRegistry([{ ...migration(2, []) }])).toThrow('expected 1');
    expect(() => validateMigrationRegistry([migration(1, []), migration(1, [])])).toThrow('expected 2');
    expect(() => validateMigrationRegistry([{ ...migration(1, []), name: '' }])).toThrow('expected 1');
  });
});

const runNodeScript = async (script: string): Promise<{ code: number | null; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr: stderr.trim() }));
  });

const migration = (version: number, applied: number[]): DatabaseMigration => ({
  version,
  name: `migration-${version}`,
  up(db) {
    db.exec(`CREATE TABLE migration_${version} (value TEXT)`);
    applied.push(version);
  },
  verify(db) {
    const row = db.prepare(`SELECT count(*) AS count FROM sqlite_schema WHERE name = 'migration_${version}'`).get() as { count: number };
    if (row.count !== 1) throw new Error(`Migration ${version} was not applied`);
  },
});

const createDatabasePath = (): { dbPath: string; secretKey: Buffer } => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-migration-test-'));
  tempDirs.push(dir);
  return { dbPath: join(dir, 'bot.sqlite'), secretKey: randomBytes(32) };
};

const track = (store: BindingStore): BindingStore => {
  stores.push(store);
  return store;
};

const createShippedBindings = (db: DatabaseSync): void => db.exec(`
  CREATE TABLE bindings (
    telegram_user_id TEXT PRIMARY KEY,
    floway_user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    encrypted_session TEXT NOT NULL,
    session_nonce TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const queryOne = (dbPath: string, sql: string): Record<string, unknown> => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(sql).get() as Record<string, unknown>;
  db.close();
  return row;
};

const pragmaFromPath = (dbPath: string, name: string): unknown => {
  const db = new DatabaseSync(dbPath);
  const value = pragmaValue(db, name);
  db.close();
  return value;
};

const pragmaValue = (db: DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
};

const tableNames = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>;
  db.close();
  return rows.map(row => row.name);
};

const tableFlags = (db: DatabaseSync): Record<string, number> => Object.fromEntries(
  (db.prepare('PRAGMA table_list').all() as unknown as Array<{ name: string; strict: number }>)
    .filter(row => ['bindings', 'quota_window_cursor', 'quota_window_event', 'quota_window_delivery'].includes(row.name))
    .map(row => [row.name, row.strict]),
);

const indexNames = (db: DatabaseSync): string[] => (
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>
).map(row => row.name);
