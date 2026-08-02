import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BindingStore,
  CURRENT_SCHEMA_VERSION,
  DatabaseRowError,
  MAX_DELIVERY_ERROR_LENGTH,
  type NewPrimaryWindowEvent,
  type PrimaryWindowFacts,
} from '../src/db.js';
import { encryptString } from '../src/crypto.js';

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

const DAY = 24 * 60 * 60 * 1_000;
const OBSERVED = Date.UTC(2026, 5, 1);

const previous: PrimaryWindowFacts = {
  startAtMs: OBSERVED,
  endAtMs: OBSERVED + 7 * DAY,
  durationMs: 7 * DAY,
  observedAtMs: OBSERVED + DAY,
  usedPercent: 73.5,
  quotaBucketKey: 'premium',
  activeLimit: 'seven-day',
};

const current: PrimaryWindowFacts = {
  startAtMs: OBSERVED + 7 * DAY,
  endAtMs: OBSERVED + 14 * DAY,
  durationMs: 7 * DAY,
  observedAtMs: OBSERVED + 7 * DAY + 1_000,
  usedPercent: 3,
  quotaBucketKey: 'premium',
  activeLimit: 'seven-day',
};

const transition = (overrides: Partial<NewPrimaryWindowEvent> = {}): NewPrimaryWindowEvent => ({
  upstreamId: 'up_a',
  fromRevision: 0,
  toRevision: 1,
  upstreamKind: 'codex',
  upstreamName: 'Alpha',
  kind: 'natural',
  previous,
  current,
  detectedAtMs: current.observedAtMs,
  effectivePreviousUsageEndAtMs: null,
  ...overrides,
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('BindingStore schema', () => {
  it('creates version 1 STRICT tables, indexes, foreign keys, and file pragmas', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const store = track(new BindingStore(dbPath, secretKey));

    const db = new DatabaseSync(dbPath);
    expect(pragmaValue(db, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);
    expect(String(pragmaValue(db, 'journal_mode')).toLowerCase()).toBe('wal');
    expect(pragmaValue(db, 'synchronous')).toBe(2);
    db.exec('PRAGMA foreign_keys = ON');
    expect(pragmaValue(db, 'foreign_keys')).toBe(1);
    expect(pragmaValue(db, 'busy_timeout')).toBe(0);
    expect(tableFlags(db)).toMatchObject({
      bindings: 1,
      primary_window_cursor: 1,
      primary_window_event: 1,
      primary_window_delivery: 1,
    });
    expect(indexNames(db)).toEqual(expect.arrayContaining([
      'primary_window_delivery_claim_idx',
      'primary_window_delivery_lease_idx',
      'primary_window_delivery_claim_token_idx',
      'primary_window_delivery_event_fk_idx',
      'primary_window_delivery_binding_fk_idx',
      'primary_window_event_retention_idx',
    ]));
    const eventFk = db.prepare('PRAGMA foreign_key_list(primary_window_event)').all() as unknown as Array<{ table: string; on_delete: string }>;
    const deliveryFks = db.prepare('PRAGMA foreign_key_list(primary_window_delivery)').all() as unknown as Array<{ table: string; on_delete: string }>;
    expect(eventFk).toContainEqual(expect.objectContaining({ table: 'primary_window_cursor', on_delete: 'RESTRICT' }));
    expect(deliveryFks).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'primary_window_event', on_delete: 'CASCADE' }),
      expect.objectContaining({ table: 'bindings', on_delete: 'CASCADE' }),
    ]));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();

    expect(store.listBindingsSafely()).toEqual({ bindings: [], errors: [], probableWrongSecret: false });
  });

  it('handles an in-memory database without requesting WAL', () => {
    const store = track(new BindingStore(':memory:', randomBytes(32)));
    expect(store.listBindingsSafely()).toEqual({ bindings: [], errors: [], probableWrongSecret: false });
  });

  it('migrates only the exact shipped binding schema and preserves encrypted bytes', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const encrypted = encryptString('preserved-session', secretKey);
    const db = new DatabaseSync(dbPath);
    createShippedBindings(db);
    db.prepare(`
      INSERT INTO bindings
        (telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('100', 7, 'alice', encrypted.ciphertext, encrypted.nonce, '2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    createDiscardedTables(db);
    db.prepare(`INSERT INTO primary_window_state VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('100', 'up_a', 'a', 'b', 20, 'premium', 'c');
    db.prepare(`INSERT INTO primary_window_notification VALUES (?, ?, ?, ?, ?)`)
      .run('100', 'up_a', 'a', 'b', 'c');
    db.close();

    const before = Date.now();
    const store = track(new BindingStore(dbPath, secretKey));
    const after = Date.now();
    const binding = store.getByTelegramUserId('100');
    expect(binding).toMatchObject({
      bindingId: 1,
      telegramUserId: '100',
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
    expect(tableNames(dbPath)).not.toEqual(expect.arrayContaining([
      'primary_window_state',
      'primary_window_notification',
    ]));
  });

  it('leaves lookalike tables untouched', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE primary_window_state_copy (value TEXT); INSERT INTO primary_window_state_copy VALUES ('keep')`);
    db.exec(`CREATE TABLE primary_window_notification_copy (value TEXT); INSERT INTO primary_window_notification_copy VALUES ('keep')`);
    db.exec(`CREATE TABLE primary_window_state (value TEXT); INSERT INTO primary_window_state VALUES ('keep')`);
    db.close();

    track(new BindingStore(dbPath, secretKey));
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining([
      'primary_window_state_copy',
      'primary_window_notification_copy',
      'primary_window_state',
    ]));
    expect(queryOne(dbPath, 'SELECT value FROM primary_window_state').value).toBe('keep');
  });

  it('rejects future versions before persistent changes', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}; CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep')`);
    db.close();

    expect(() => new BindingStore(dbPath, secretKey)).toThrow('newer than supported');
    expect(tableNames(dbPath)).toEqual(['sentinel']);
    expect(queryOne(dbPath, 'PRAGMA user_version').user_version).toBe(CURRENT_SCHEMA_VERSION + 1);
  });

  it('rolls back incompatible version-0 databases and unexpected new table names', () => {
    for (const setup of [
      (db: DatabaseSync) => db.exec('CREATE TABLE bindings (telegram_user_id TEXT PRIMARY KEY, wrong TEXT)'),
      (db: DatabaseSync) => db.exec('CREATE TABLE primary_window_cursor (sentinel TEXT)'),
    ]) {
      const { dbPath, secretKey } = createDatabasePath();
      const db = new DatabaseSync(dbPath);
      setup(db);
      db.close();
      const beforeTables = tableNames(dbPath);
      expect(() => new BindingStore(dbPath, secretKey)).toThrow();
      expect(tableNames(dbPath)).toEqual(beforeTables);
      expect(queryOne(dbPath, 'PRAGMA user_version').user_version).toBe(0);
    }
  });

  it('rejects a current-version database whose table definition changed', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const initial = new BindingStore(dbPath, secretKey);
    initial.close();
    const db = new DatabaseSync(dbPath);
    db.exec('ALTER TABLE bindings ADD COLUMN unexpected TEXT');
    db.close();

    expect(() => new BindingStore(dbPath, secretKey)).toThrow('schema does not match');
    expect(queryOne(dbPath, 'PRAGMA user_version').user_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('reopens the current schema idempotently', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const first = new BindingStore(dbPath, secretKey);
    const binding = first.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'token' }, OBSERVED);
    first.close();

    const reopened = track(new BindingStore(dbPath, secretKey));
    expect(reopened.getByBindingId(binding.bindingId)?.flowaySession).toBe('token');
    expect(tableNames(dbPath).filter(name => name.startsWith('primary_window_'))).toHaveLength(3);
  });
});

describe('BindingStore bindings', () => {
  it('allocates fresh IDs on every true bind and never reuses IDs', () => {
    const store = createStore();
    const one = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'one' }, OBSERVED);
    const two = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'two' }, OBSERVED + 1);
    expect(two.bindingId).toBeGreaterThan(one.bindingId);
    expect(store.getByBindingId(one.bindingId)).toBeNull();
    expect(store.getByTelegramUserId('100')).toMatchObject({ bindingId: two.bindingId, flowaySession: 'two' });

    expect(store.deleteBinding({ bindingId: two.bindingId, telegramUserId: '100' })).toBe('deleted');
    const three = store.replaceBinding({ telegramUserId: '101', flowayUserId: 2, username: 'bob', flowaySession: 'three' }, OBSERVED + 2);
    expect(three.bindingId).toBeGreaterThan(two.bindingId);
  });

  it('rejects stale delete expectations and principal-changing refreshes', () => {
    const store = createStore();
    const old = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'token' }, OBSERVED);
    const currentBinding = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'new-token' }, OBSERVED + 1);

    expect(store.deleteBinding({ bindingId: old.bindingId, telegramUserId: '100' })).toBe('stale');
    expect(store.refreshBinding(currentBinding.bindingId, { flowayUserId: 2, username: 'mallory' }, OBSERVED + 2))
      .toEqual({ status: 'principal-mismatch' });
    expect(store.refreshBinding(currentBinding.bindingId, { username: 'renamed' }, OBSERVED + 3))
      .toMatchObject({ status: 'updated', binding: { username: 'renamed', flowaySession: 'new-token' } });
    expect(store.refreshBinding(old.bindingId, { username: 'nobody' })).toEqual({ status: 'missing' });
  });

  it('isolates malformed ciphertext and signals a probable wrong secret only when all rows fail decryption', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const store = track(new BindingStore(dbPath, secretKey));
    const good = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'good' }, OBSERVED);
    const bad = store.replaceBinding({ telegramUserId: '101', flowayUserId: 2, username: 'bob', flowaySession: 'bad' }, OBSERVED);
    rawExec(dbPath, `UPDATE bindings SET encrypted_session = 'not-valid' WHERE id = ${bad.bindingId}`);

    expect(store.listBindingsSafely()).toMatchObject({
      bindings: [expect.objectContaining({ bindingId: good.bindingId })],
      errors: [expect.objectContaining({ bindingId: bad.bindingId, code: 'decrypt-failed' })],
      probableWrongSecret: false,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const wrongSecretStore = track(new BindingStore(dbPath, randomBytes(32)));
    const result = wrongSecretStore.listBindingsSafely();
    expect(result.bindings).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.probableWrongSecret).toBe(true);
    expect(result.errors.map(error => error.message).join(' ')).not.toContain('good');
  });
});

describe('BindingStore cursor and transition transactions', () => {
  it('seeds with CAS, preserves the anchor on observations, and stages/replaces/clears candidates', () => {
    const store = createStore();
    expect(store.seedCursor('up_a', previous).status).toBe('seeded');
    expect(store.seedCursor('up_a', current).status).toBe('exists');
    expect(store.updateSameObservation('up_a', 0, { ...previous, usedPercent: 80 }).status).toBe('updated');
    expect(store.getCursor('up_a')).toMatchObject({
      revision: 0,
      anchor: {
        startAtMs: previous.startAtMs,
        endAtMs: previous.endAtMs,
        durationMs: previous.durationMs,
        observedAtMs: previous.observedAtMs,
      },
      latest: { ...previous, usedPercent: 80 },
    });

    const pending = {
      kind: 'natural' as const,
      startAtMs: current.startAtMs,
      endAtMs: current.endAtMs,
      durationMs: current.durationMs,
      observedAtMs: current.observedAtMs,
      firstSeenAtMs: current.observedAtMs,
      observationCount: 1,
    };
    expect(store.stagePendingCandidate('up_a', 0, pending).status).toBe('updated');
    expect(store.stagePendingCandidate('up_a', 0, pending).status).toBe('candidate-mismatch');
    expect(store.replacePendingCandidate('up_a', 0, { ...pending, observationCount: 2 }).status).toBe('updated');
    expect(store.clearPendingCandidate('up_a', 0).status).toBe('updated');
    expect(store.getCursor('up_a')?.pending).toBeNull();
  });

  it('commits an event, cursor advance, pending clear, and eligible deliveries atomically', () => {
    const store = createStore();
    const eligible = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    const tooNew = store.replaceBinding({ telegramUserId: '101', flowayUserId: 2, username: 'bob', flowaySession: 'b' }, current.observedAtMs + 1);
    seedPending(store);

    const result = store.commitTransition(0, transition(), [eligible.bindingId, tooNew.bindingId, 999_999], current.observedAtMs);
    expect(result).toMatchObject({ status: 'committed', deliveryCount: 1 });
    expect(store.getCursor('up_a')).toMatchObject({
      revision: 1,
      anchor: {
        startAtMs: current.startAtMs,
        endAtMs: current.endAtMs,
        durationMs: current.durationMs,
        observedAtMs: current.observedAtMs,
      },
      pending: null,
    });
    expect(store.listEvents('up_a')).toHaveLength(1);
    expect(store.listDeliveries()).toEqual([
      expect.objectContaining({ bindingId: eligible.bindingId, status: 'pending', attempts: 0 }),
    ]);
    expect(store.commitTransition(0, transition(), [eligible.bindingId], current.observedAtMs)).toEqual({ status: 'stale' });
  });

  it('rejects transition facts that do not exactly match the persisted cursor candidate', () => {
    const mismatches: NewPrimaryWindowEvent[] = [
      transition({ previous: { ...previous, usedPercent: 72 } }),
      transition({
        kind: 'manual',
        effectivePreviousUsageEndAtMs: previous.endAtMs,
      }),
      transition({
        current: {
          ...current,
          startAtMs: current.startAtMs + 1,
          durationMs: current.durationMs - 1,
        },
      }),
    ];

    for (const mismatched of mismatches) {
      const store = createStore();
      seedPending(store);
      expect(store.commitTransition(0, mismatched, [], current.observedAtMs))
        .toEqual({ status: 'candidate-mismatch' });
      expect(store.getCursor('up_a')).toMatchObject({
        revision: 0,
        anchor: {
          startAtMs: previous.startAtMs,
          endAtMs: previous.endAtMs,
          durationMs: previous.durationMs,
          observedAtMs: previous.observedAtMs,
        },
        pending: { firstSeenAtMs: current.observedAtMs },
      });
      expect(store.listEvents()).toEqual([]);
      expect(store.listDeliveries()).toEqual([]);
    }
  });

  it('rolls the entire transition back if event insertion fails', () => {
    const store = createStore();
    seedPending(store);
    const invalid = transition({ upstreamName: '' });
    expect(() => store.commitTransition(0, invalid, [], current.observedAtMs)).toThrow();
    expect(store.getCursor('up_a')).toMatchObject({ revision: 0, pending: { firstSeenAtMs: current.observedAtMs } });
    expect(store.listEvents()).toEqual([]);
    expect(store.listDeliveries()).toEqual([]);
  });

  it('cascades binding deliveries and restricts cursor deletion while events remain', () => {
    const store = createStore();
    const binding = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    seedPending(store);
    const committed = store.commitTransition(0, transition(), [binding.bindingId], current.observedAtMs);
    expect(committed.status).toBe('committed');
    expect(store.resetCursor('up_a')).toBe(true);
    expect(store.listEvents()).toEqual([]);
    expect(store.listDeliveries()).toEqual([]);
  });

  it('surfaces corrupt cursor rows and permits an explicit reset', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const store = track(new BindingStore(dbPath, secretKey));
    store.seedCursor('up_a', previous);
    rawExec(dbPath, 'PRAGMA ignore_check_constraints = ON; UPDATE primary_window_cursor SET anchor_duration_ms = 1; PRAGMA ignore_check_constraints = OFF');
    expect(() => store.getCursor('up_a')).toThrow(DatabaseRowError);
    expect(store.resetCursor('up_a')).toBe(true);
    expect(store.getCursor('up_a')).toBeNull();
  });
});

describe('BindingStore delivery outbox', () => {
  it('allows only one of two connections to claim a due delivery and reclaims expired leases', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const first = track(new BindingStore(dbPath, secretKey));
    const binding = first.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    seedPending(first);
    first.commitTransition(0, transition(), [binding.bindingId], current.observedAtMs);
    const second = track(new BindingStore(dbPath, secretKey));

    const claim = first.claimDueDelivery({ nowMs: current.observedAtMs, leaseDurationMs: 1_000, claimToken: 'worker-a' });
    expect(claim).toMatchObject({ status: 'leased', attempts: 1, claimToken: 'worker-a' });
    expect(second.claimDueDelivery({ nowMs: current.observedAtMs, leaseDurationMs: 1_000, claimToken: 'worker-b' })).toBeNull();
    expect(second.claimDueDelivery({ nowMs: current.observedAtMs + 1_000, leaseDurationMs: 1_000, claimToken: 'worker-b' }))
      .toMatchObject({ status: 'leased', attempts: 2, claimToken: 'worker-b' });
  });

  it('rejects mutations from an expired lease before another worker reclaims it', () => {
    const store = createStore();
    const binding = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    seedPending(store);
    store.commitTransition(0, transition(), [binding.bindingId], current.observedAtMs);

    const claim = store.claimDueDelivery({ nowMs: current.observedAtMs, leaseDurationMs: 1_000, claimToken: 'expired' })!;
    const expiredAt = current.observedAtMs + 1_000;
    expect(store.persistDeliveryPayload(claim.deliveryId, 'expired', 'payload', expiredAt)).toBe(false);
    expect(store.markDeliveryRetry(claim.deliveryId, 'expired', expiredAt + 1_000, 'late', expiredAt)).toBe(false);
    expect(store.markDeliverySkipped(claim.deliveryId, 'expired', 'late', expiredAt)).toBe(false);
    expect(store.markDeliveryDead(claim.deliveryId, 'expired', 'late', expiredAt)).toBe(false);
  });

  it('uses token CAS for payload, retry, sent, skipped, and dead transitions', () => {
    const store = createStore();
    const binding = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    seedPending(store);
    store.commitTransition(0, transition(), [binding.bindingId], current.observedAtMs);

    const claim = store.claimDueDelivery({ nowMs: current.observedAtMs, leaseDurationMs: 1_000, claimToken: 'one' })!;
    expect(store.persistDeliveryPayload(claim.deliveryId, 'wrong', 'payload', current.observedAtMs)).toBe(false);
    expect(store.persistDeliveryPayload(claim.deliveryId, 'one', 'payload', current.observedAtMs)).toBe(true);
    expect(store.persistDeliveryPayload(claim.deliveryId, 'one', 'different payload', current.observedAtMs)).toBe(false);
    expect(store.getDelivery(claim.deliveryId)?.payload).toBe('payload');
    expect(store.markDeliveryRetry(claim.deliveryId, 'one', current.observedAtMs + 2_000, 'x'.repeat(2_000), current.observedAtMs + 1)).toBe(true);
    expect(store.getDelivery(claim.deliveryId)?.lastError).toHaveLength(MAX_DELIVERY_ERROR_LENGTH);
    expect(store.claimDueDelivery({ nowMs: current.observedAtMs + 1_999, leaseDurationMs: 1_000 })).toBeNull();

    const retried = store.claimDueDelivery({ nowMs: current.observedAtMs + 2_000, leaseDurationMs: 1_000, claimToken: 'two' })!;
    expect(store.markDeliverySent(retried.deliveryId, 'one', current.observedAtMs + 2_001)).toBe(false);
    expect(store.markDeliverySent(retried.deliveryId, 'two', current.observedAtMs + 2_001)).toBe(true);
    expect(store.getDelivery(retried.deliveryId)).toMatchObject({ status: 'sent', sentAtMs: current.observedAtMs + 2_001 });
  });

  it('purges only bounded old events whose deliveries are terminal', () => {
    const store = createStore();
    const binding = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    seedPending(store);
    const committed = store.commitTransition(0, transition(), [binding.bindingId], current.observedAtMs);
    expect(committed.status).toBe('committed');
    expect(store.purgeTerminalEvents(current.observedAtMs + 1)).toBe(0);

    const claim = store.claimDueDelivery({ nowMs: current.observedAtMs, leaseDurationMs: 1_000, claimToken: 'terminal' })!;
    expect(store.markDeliverySkipped(claim.deliveryId, 'terminal', 'not eligible', current.observedAtMs + 1)).toBe(true);
    expect(store.purgeTerminalEvents(current.observedAtMs + 2, 10_000)).toBe(1);
    expect(store.listEvents()).toEqual([]);
    expect(store.listDeliveries()).toEqual([]);
  });

  it('terminally handles a malformed claimable delivery without exposing its row to callers', () => {
    const { dbPath, secretKey } = createDatabasePath();
    const store = track(new BindingStore(dbPath, secretKey));
    const binding = store.replaceBinding({ telegramUserId: '100', flowayUserId: 1, username: 'alice', flowaySession: 'a' }, OBSERVED);
    seedPending(store);
    store.commitTransition(0, transition(), [binding.bindingId], current.observedAtMs);
    rawExec(dbPath, "PRAGMA ignore_check_constraints = ON; UPDATE primary_window_delivery SET attempts = -1; PRAGMA ignore_check_constraints = OFF");

    expect(store.claimDueDelivery({ nowMs: current.observedAtMs, leaseDurationMs: 1_000 })).toBeNull();
    expect(queryOne(dbPath, 'SELECT status, last_error FROM primary_window_delivery')).toEqual({
      status: 'dead',
      last_error: 'Malformed delivery row',
    });
  });
});

const createStore = (): BindingStore => {
  const { dbPath, secretKey } = createDatabasePath();
  return track(new BindingStore(dbPath, secretKey));
};

const createDatabasePath = (): { dbPath: string; secretKey: Buffer } => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-db-test-'));
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

const createDiscardedTables = (db: DatabaseSync): void => db.exec(`
  CREATE TABLE primary_window_state (
    telegram_user_id TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    window_start_at TEXT NOT NULL,
    reset_after_at TEXT NOT NULL,
    used_percent REAL,
    quota_bucket_key TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (telegram_user_id, upstream_id)
  );
  CREATE TABLE primary_window_notification (
    telegram_user_id TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    window_start_at TEXT NOT NULL,
    reset_after_at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (telegram_user_id, upstream_id, window_start_at, reset_after_at)
  );
`);

const seedPending = (store: BindingStore): void => {
  store.seedCursor('up_a', previous);
  const result = store.stagePendingCandidate('up_a', 0, {
    kind: 'natural',
    startAtMs: current.startAtMs,
    endAtMs: current.endAtMs,
    durationMs: current.durationMs,
    observedAtMs: current.observedAtMs,
    firstSeenAtMs: current.observedAtMs,
  });
  expect(result.status).toBe('updated');
};

const rawExec = (dbPath: string, sql: string): void => {
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
};

const queryOne = (dbPath: string, sql: string): Record<string, unknown> => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(sql).get() as Record<string, unknown>;
  db.close();
  return row;
};

const tableNames = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>;
  db.close();
  return rows.map(row => row.name);
};

const tableFlags = (db: DatabaseSync): Record<string, number> => Object.fromEntries(
  (db.prepare('PRAGMA table_list').all() as unknown as Array<{ name: string; strict: number }>)
    .filter(row => ['bindings', 'primary_window_cursor', 'primary_window_event', 'primary_window_delivery'].includes(row.name))
    .map(row => [row.name, row.strict]),
);

const indexNames = (db: DatabaseSync): string[] => (
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>
).map(row => row.name);

const pragmaValue = (db: DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
};
