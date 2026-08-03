import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BindingStore,
  DatabaseRowError,
  MAX_DELIVERY_ERROR_LENGTH,
  type NewQuotaWindowEvent,
  type QuotaWindowFacts,
} from '../src/db.js';

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

const DAY = 24 * 60 * 60 * 1_000;
const OBSERVED = Date.UTC(2026, 5, 1);

const previous: QuotaWindowFacts = {
  startAtMs: OBSERVED,
  endAtMs: OBSERVED + 7 * DAY,
  durationMs: 7 * DAY,
  observedAtMs: OBSERVED + DAY,
  usedPercent: 73.5,
  quotaBucketKey: 'premium',
  activeLimit: 'seven-day',
};

const current: QuotaWindowFacts = {
  startAtMs: OBSERVED + 7 * DAY,
  endAtMs: OBSERVED + 14 * DAY,
  durationMs: 7 * DAY,
  observedAtMs: OBSERVED + 7 * DAY + 1_000,
  usedPercent: 3,
  quotaBucketKey: 'premium',
  activeLimit: 'seven-day',
};

const transition = (overrides: Partial<NewQuotaWindowEvent> = {}): NewQuotaWindowEvent => ({
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
    const mismatches: NewQuotaWindowEvent[] = [
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
