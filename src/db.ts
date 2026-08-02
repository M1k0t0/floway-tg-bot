import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { decryptString, encryptString } from './crypto.js';
import { MAX_DELIVERY_ERROR_LENGTH, MAX_TIMESTAMP_MS } from './db-constraints.js';
import { applyMigrations } from './db-migrations/index.js';
import type { Binding } from './types.js';

export { MAX_DELIVERY_ERROR_LENGTH } from './db-constraints.js';
export { CURRENT_SCHEMA_VERSION } from './db-migrations/index.js';
export const DATABASE_BUSY_TIMEOUT_MS = 5_000;
export const MAX_PURGE_BATCH_SIZE = 500;
const BINDING_COLUMNS = 'id, telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, bound_at_ms, updated_at_ms';
const CURSOR_COLUMNS = `
  upstream_id, revision,
  anchor_start_at_ms, anchor_end_at_ms, anchor_duration_ms, anchor_observed_at_ms,
  latest_start_at_ms, latest_end_at_ms, latest_duration_ms, latest_observed_at_ms,
  latest_used_percent, latest_quota_bucket_key, latest_active_limit,
  pending_kind, pending_start_at_ms, pending_end_at_ms, pending_duration_ms,
  pending_observed_at_ms, pending_first_seen_at_ms, pending_observation_count
`;
const EVENT_COLUMNS = `
  id, upstream_id, from_revision, to_revision, upstream_kind, upstream_name, kind,
  previous_start_at_ms, previous_end_at_ms, previous_duration_ms, previous_observed_at_ms,
  previous_used_percent, previous_quota_bucket_key, previous_active_limit,
  current_start_at_ms, current_end_at_ms, current_duration_ms, current_observed_at_ms,
  current_used_percent, current_quota_bucket_key, current_active_limit,
  detected_at_ms, effective_previous_usage_end_at_ms
`;
const DELIVERY_COLUMNS = `
  id, event_id, binding_id, status, payload, attempts, next_attempt_at_ms,
  claim_token, claim_until_ms, sent_at_ms, dead_at_ms, last_error,
  created_at_ms, updated_at_ms
`;

interface BindingRow {
  id: unknown;
  telegram_user_id: unknown;
  floway_user_id: unknown;
  username: unknown;
  encrypted_session: unknown;
  session_nonce: unknown;
  bound_at_ms: unknown;
  updated_at_ms: unknown;
}

interface CursorRow {
  upstream_id: unknown;
  revision: unknown;
  anchor_start_at_ms: unknown;
  anchor_end_at_ms: unknown;
  anchor_duration_ms: unknown;
  anchor_observed_at_ms: unknown;
  latest_start_at_ms: unknown;
  latest_end_at_ms: unknown;
  latest_duration_ms: unknown;
  latest_observed_at_ms: unknown;
  latest_used_percent: unknown;
  latest_quota_bucket_key: unknown;
  latest_active_limit: unknown;
  pending_kind: unknown;
  pending_start_at_ms: unknown;
  pending_end_at_ms: unknown;
  pending_duration_ms: unknown;
  pending_observed_at_ms: unknown;
  pending_first_seen_at_ms: unknown;
  pending_observation_count: unknown;
}

interface EventRow {
  id: unknown;
  upstream_id: unknown;
  from_revision: unknown;
  to_revision: unknown;
  upstream_kind: unknown;
  upstream_name: unknown;
  kind: unknown;
  previous_start_at_ms: unknown;
  previous_end_at_ms: unknown;
  previous_duration_ms: unknown;
  previous_observed_at_ms: unknown;
  previous_used_percent: unknown;
  previous_quota_bucket_key: unknown;
  previous_active_limit: unknown;
  current_start_at_ms: unknown;
  current_end_at_ms: unknown;
  current_duration_ms: unknown;
  current_observed_at_ms: unknown;
  current_used_percent: unknown;
  current_quota_bucket_key: unknown;
  current_active_limit: unknown;
  detected_at_ms: unknown;
  effective_previous_usage_end_at_ms: unknown;
}

interface DeliveryRow {
  id: unknown;
  event_id: unknown;
  binding_id: unknown;
  status: unknown;
  payload: unknown;
  attempts: unknown;
  next_attempt_at_ms: unknown;
  claim_token: unknown;
  claim_until_ms: unknown;
  sent_at_ms: unknown;
  dead_at_ms: unknown;
  last_error: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
}

export type DatabaseRowErrorCode = 'invalid-row' | 'decrypt-failed';

export class DatabaseRowError extends Error {
  constructor(
    public readonly table: 'bindings' | 'primary_window_cursor' | 'primary_window_event' | 'primary_window_delivery',
    public readonly rowIdentifier: string,
    public readonly code: DatabaseRowErrorCode = 'invalid-row',
  ) {
    super(`Unable to decode ${table} row ${rowIdentifier}`);
    this.name = 'DatabaseRowError';
  }
}

export interface BindingListRowError {
  bindingId: number | null;
  telegramUserId: string | null;
  code: DatabaseRowErrorCode;
  message: string;
}

export interface SafeBindingList {
  bindings: Binding[];
  errors: BindingListRowError[];
  probableWrongSecret: boolean;
}

export type BindingRefreshInput =
  | { username: string; flowayUserId?: never }
  | { username: string; flowayUserId: number };

export type BindingRefreshResult =
  | { status: 'updated'; binding: Binding }
  | { status: 'missing' }
  | { status: 'principal-mismatch' };

export interface BindingExpectation {
  bindingId: number;
  telegramUserId: string;
}

export type DeleteBindingResult = 'deleted' | 'missing' | 'stale';

export interface PrimaryWindowAnchor {
  startAtMs: number;
  endAtMs: number;
  durationMs: number;
  observedAtMs: number;
}

export interface PrimaryWindowFacts extends PrimaryWindowAnchor {
  usedPercent: number | null;
  quotaBucketKey: string | null;
  activeLimit: string | null;
}

export type PrimaryWindowTransitionKind = 'natural' | 'manual';

export interface PendingPrimaryWindowCandidate extends PrimaryWindowAnchor {
  kind: PrimaryWindowTransitionKind;
  firstSeenAtMs: number;
  observationCount: number;
}

export interface PrimaryWindowCursor {
  upstreamId: string;
  revision: number;
  anchor: PrimaryWindowAnchor;
  latest: PrimaryWindowFacts;
  pending: PendingPrimaryWindowCandidate | null;
}

export interface NewPrimaryWindowEvent {
  upstreamId: string;
  fromRevision: number;
  toRevision: number;
  upstreamKind: string;
  upstreamName: string;
  kind: PrimaryWindowTransitionKind;
  previous: PrimaryWindowFacts;
  current: PrimaryWindowFacts;
  detectedAtMs: number;
  effectivePreviousUsageEndAtMs: number | null;
}

export interface PrimaryWindowEvent extends NewPrimaryWindowEvent {
  eventId: number;
}

export type CursorMutationResult =
  | { status: 'updated'; cursor: PrimaryWindowCursor }
  | { status: 'missing' | 'stale' | 'candidate-mismatch' };

export type SeedCursorResult =
  | { status: 'seeded'; cursor: PrimaryWindowCursor }
  | { status: 'exists'; cursor: PrimaryWindowCursor };

export type CommitTransitionResult =
  | { status: 'committed'; event: PrimaryWindowEvent; deliveryCount: number }
  | { status: 'missing' | 'stale' | 'candidate-mismatch' };

export type DeliveryStatus = 'pending' | 'leased' | 'sent' | 'skipped' | 'dead';

export interface PrimaryWindowDelivery {
  deliveryId: number;
  eventId: number;
  bindingId: number;
  status: DeliveryStatus;
  payload: string | null;
  attempts: number;
  nextAttemptAtMs: number;
  claimToken: string | null;
  claimUntilMs: number | null;
  sentAtMs: number | null;
  deadAtMs: number | null;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ClaimDeliveryInput {
  nowMs: number;
  leaseDurationMs: number;
  claimToken?: string;
}

export class BindingStore {
  private readonly db: DatabaseSync;

  constructor(
    private readonly dbPath: string,
    private readonly secretKey: Buffer,
  ) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.assertConnectionPragmas();

      applyMigrations(this.db);
      if (dbPath !== ':memory:') this.configureFileDatabase();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  replaceBinding(
    input: { telegramUserId: string; flowayUserId: number; username: string; flowaySession: string },
    nowMs = Date.now(),
  ): Binding {
    validateBindingInput(input);
    assertTimestamp(nowMs, 'binding timestamp');
    const encrypted = encryptString(input.flowaySession, this.secretKey);
    return this.immediateTransaction(() => {
      this.db.prepare('DELETE FROM bindings WHERE telegram_user_id = ?').run(input.telegramUserId);
      const result = this.db.prepare(`
        INSERT INTO bindings (
          telegram_user_id, floway_user_id, username, encrypted_session, session_nonce,
          bound_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.telegramUserId,
        input.flowayUserId,
        input.username,
        encrypted.ciphertext,
        encrypted.nonce,
        nowMs,
        nowMs,
      );
      const bindingId = safeRowId(result.lastInsertRowid, 'bindings');
      return {
        bindingId,
        telegramUserId: input.telegramUserId,
        flowayUserId: input.flowayUserId,
        username: input.username,
        flowaySession: input.flowaySession,
        createdAt: timestampPresentation(nowMs),
        updatedAt: timestampPresentation(nowMs),
      };
    });
  }

  getByTelegramUserId(telegramUserId: string): Binding | null {
    const row = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM bindings WHERE telegram_user_id = ?`)
      .get(telegramUserId) as BindingRow | undefined;
    return row ? this.decodeBinding(row) : null;
  }

  getByBindingId(bindingId: number): Binding | null {
    assertSafeInteger(bindingId, 'binding id', 1);
    const row = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM bindings WHERE id = ?`)
      .get(bindingId) as BindingRow | undefined;
    return row ? this.decodeBinding(row) : null;
  }

  listBindingsSafely(): SafeBindingList {
    const rows = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM bindings ORDER BY id`).all() as unknown as BindingRow[];
    const bindings: Binding[] = [];
    const errors: BindingListRowError[] = [];
    for (const row of rows) {
      try {
        bindings.push(this.decodeBinding(row));
      } catch (error) {
        const rowError = error instanceof DatabaseRowError
          ? error
          : new DatabaseRowError('bindings', safeIdentifier(row.id));
        errors.push({
          bindingId: safeOptionalInteger(row.id),
          telegramUserId: typeof row.telegram_user_id === 'string' ? row.telegram_user_id : null,
          code: rowError.code,
          message: rowError.message,
        });
      }
    }
    return {
      bindings,
      errors,
      probableWrongSecret: rows.length > 0
        && bindings.length === 0
        && errors.every(error => error.code === 'decrypt-failed'),
    };
  }

  refreshBinding(expectedBindingId: number, input: BindingRefreshInput, nowMs = Date.now()): BindingRefreshResult {
    assertSafeInteger(expectedBindingId, 'binding id', 1);
    validateUsername(input.username);
    if (input.flowayUserId !== undefined) assertSafeInteger(input.flowayUserId, 'Floway user id', 1);
    assertTimestamp(nowMs, 'binding timestamp');
    return this.immediateTransaction(() => {
      const row = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM bindings WHERE id = ?`)
        .get(expectedBindingId) as BindingRow | undefined;
      if (!row) return { status: 'missing' };
      const flowayUserId = requireSafeInteger(row.floway_user_id, 'bindings', safeIdentifier(row.id), 1);
      if (input.flowayUserId !== undefined && input.flowayUserId !== flowayUserId) {
        return { status: 'principal-mismatch' };
      }
      this.db.prepare('UPDATE bindings SET username = ?, updated_at_ms = ? WHERE id = ?')
        .run(input.username, nowMs, expectedBindingId);
      const updated = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM bindings WHERE id = ?`)
        .get(expectedBindingId) as unknown as BindingRow;
      return { status: 'updated', binding: this.decodeBinding(updated) };
    });
  }

  deleteBinding(expected: number | BindingExpectation): DeleteBindingResult {
    const bindingId = typeof expected === 'number' ? expected : expected.bindingId;
    assertSafeInteger(bindingId, 'binding id', 1);
    if (typeof expected !== 'number' && expected.telegramUserId.length === 0) {
      throw new TypeError('Telegram user id must not be empty');
    }
    return this.immediateTransaction(() => {
      if (typeof expected !== 'number') {
        const current = this.db.prepare('SELECT id FROM bindings WHERE telegram_user_id = ?')
          .get(expected.telegramUserId) as { id: unknown } | undefined;
        if (!current) return 'missing';
        if (requireSafeInteger(current.id, 'bindings', expected.telegramUserId, 1) !== bindingId) return 'stale';
      }
      const result = this.db.prepare('DELETE FROM bindings WHERE id = ?').run(bindingId);
      return result.changes === 1 ? 'deleted' : 'missing';
    });
  }

  seedCursor(upstreamId: string, observation: PrimaryWindowFacts): SeedCursorResult {
    validateText(upstreamId, 'upstream id');
    validateFacts(observation);
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        INSERT INTO primary_window_cursor (
          upstream_id, revision,
          anchor_start_at_ms, anchor_end_at_ms, anchor_duration_ms, anchor_observed_at_ms,
          latest_start_at_ms, latest_end_at_ms, latest_duration_ms, latest_observed_at_ms,
          latest_used_percent, latest_quota_bucket_key, latest_active_limit
        ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (upstream_id) DO NOTHING
      `).run(
        upstreamId,
        observation.startAtMs,
        observation.endAtMs,
        observation.durationMs,
        observation.observedAtMs,
        observation.startAtMs,
        observation.endAtMs,
        observation.durationMs,
        observation.observedAtMs,
        observation.usedPercent,
        observation.quotaBucketKey,
        observation.activeLimit,
      );
      const cursor = this.getCursor(upstreamId);
      if (!cursor) throw new Error('Cursor seed did not produce a row');
      return result.changes === 1 ? { status: 'seeded', cursor } : { status: 'exists', cursor };
    });
  }

  getCursor(upstreamId: string): PrimaryWindowCursor | null {
    const row = this.db.prepare(`SELECT ${CURSOR_COLUMNS} FROM primary_window_cursor WHERE upstream_id = ?`)
      .get(upstreamId) as CursorRow | undefined;
    return row ? decodeCursor(row) : null;
  }

  resetCursor(upstreamId: string): boolean {
    validateText(upstreamId, 'upstream id');
    return this.immediateTransaction(() => {
      this.db.prepare('DELETE FROM primary_window_event WHERE upstream_id = ?').run(upstreamId);
      return this.db.prepare('DELETE FROM primary_window_cursor WHERE upstream_id = ?').run(upstreamId).changes === 1;
    });
  }

  updateSameObservation(upstreamId: string, expectedRevision: number, observation: PrimaryWindowFacts): CursorMutationResult {
    validateText(upstreamId, 'upstream id');
    assertSafeInteger(expectedRevision, 'cursor revision', 0);
    validateFacts(observation);
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE primary_window_cursor SET
          latest_start_at_ms = ?, latest_end_at_ms = ?, latest_duration_ms = ?, latest_observed_at_ms = ?,
          latest_used_percent = ?, latest_quota_bucket_key = ?, latest_active_limit = ?,
          pending_kind = NULL, pending_start_at_ms = NULL, pending_end_at_ms = NULL,
          pending_duration_ms = NULL, pending_observed_at_ms = NULL,
          pending_first_seen_at_ms = NULL, pending_observation_count = NULL
        WHERE upstream_id = ? AND revision = ?
      `).run(
        observation.startAtMs,
        observation.endAtMs,
        observation.durationMs,
        observation.observedAtMs,
        observation.usedPercent,
        observation.quotaBucketKey,
        observation.activeLimit,
        upstreamId,
        expectedRevision,
      );
      return this.cursorMutationResult(upstreamId, expectedRevision, Number(result.changes));
    });
  }

  stagePendingCandidate(
    upstreamId: string,
    expectedRevision: number,
    candidate: Omit<PendingPrimaryWindowCandidate, 'observationCount'>,
  ): CursorMutationResult {
    validatePendingCandidate({ ...candidate, observationCount: 1 });
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE primary_window_cursor SET
          pending_kind = ?, pending_start_at_ms = ?, pending_end_at_ms = ?, pending_duration_ms = ?,
          pending_observed_at_ms = ?, pending_first_seen_at_ms = ?, pending_observation_count = 1
        WHERE upstream_id = ? AND revision = ? AND pending_kind IS NULL
      `).run(
        candidate.kind,
        candidate.startAtMs,
        candidate.endAtMs,
        candidate.durationMs,
        candidate.observedAtMs,
        candidate.firstSeenAtMs,
        upstreamId,
        expectedRevision,
      );
      return this.cursorMutationResult(upstreamId, expectedRevision, Number(result.changes), true);
    });
  }

  replacePendingCandidate(
    upstreamId: string,
    expectedRevision: number,
    candidate: PendingPrimaryWindowCandidate,
  ): CursorMutationResult {
    validatePendingCandidate(candidate);
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE primary_window_cursor SET
          pending_kind = ?, pending_start_at_ms = ?, pending_end_at_ms = ?, pending_duration_ms = ?,
          pending_observed_at_ms = ?, pending_first_seen_at_ms = ?, pending_observation_count = ?
        WHERE upstream_id = ? AND revision = ?
      `).run(
        candidate.kind,
        candidate.startAtMs,
        candidate.endAtMs,
        candidate.durationMs,
        candidate.observedAtMs,
        candidate.firstSeenAtMs,
        candidate.observationCount,
        upstreamId,
        expectedRevision,
      );
      return this.cursorMutationResult(upstreamId, expectedRevision, Number(result.changes));
    });
  }

  clearPendingCandidate(upstreamId: string, expectedRevision: number): CursorMutationResult {
    return this.immediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE primary_window_cursor SET
          pending_kind = NULL, pending_start_at_ms = NULL, pending_end_at_ms = NULL,
          pending_duration_ms = NULL, pending_observed_at_ms = NULL,
          pending_first_seen_at_ms = NULL, pending_observation_count = NULL
        WHERE upstream_id = ? AND revision = ?
      `).run(upstreamId, expectedRevision);
      return this.cursorMutationResult(upstreamId, expectedRevision, Number(result.changes));
    });
  }

  commitTransition(
    expectedRevision: number,
    event: NewPrimaryWindowEvent,
    eligibleBindingIds: readonly number[],
    candidateFirstSeenAtMs: number,
  ): CommitTransitionResult {
    validateEvent(event);
    assertSafeInteger(expectedRevision, 'cursor revision', 0);
    assertTimestamp(candidateFirstSeenAtMs, 'candidate first-seen timestamp');
    if (event.fromRevision !== expectedRevision || event.toRevision !== expectedRevision + 1) {
      throw new TypeError('Event revisions do not match the expected cursor revision');
    }
    const uniqueBindingIds = [...new Set(eligibleBindingIds)];
    for (const bindingId of uniqueBindingIds) assertSafeInteger(bindingId, 'binding id', 1);

    return this.immediateTransaction(() => {
      const cursorRow = this.db.prepare(`SELECT ${CURSOR_COLUMNS} FROM primary_window_cursor WHERE upstream_id = ?`)
        .get(event.upstreamId) as CursorRow | undefined;
      if (!cursorRow) return { status: 'missing' };
      const cursor = decodeCursor(cursorRow);
      if (cursor.revision !== expectedRevision) return { status: 'stale' };
      if (!cursor.pending || cursor.pending.firstSeenAtMs !== candidateFirstSeenAtMs) {
        return { status: 'candidate-mismatch' };
      }
      if (!factsExactlyEqual(event.previous, cursor.latest)
        || event.kind !== cursor.pending.kind
        || !eventMatchesPendingCandidate(event.current, cursor.pending)) {
        return { status: 'candidate-mismatch' };
      }

      const inserted = this.db.prepare(`
        INSERT INTO primary_window_event (
          upstream_id, from_revision, to_revision, upstream_kind, upstream_name, kind,
          previous_start_at_ms, previous_end_at_ms, previous_duration_ms, previous_observed_at_ms,
          previous_used_percent, previous_quota_bucket_key, previous_active_limit,
          current_start_at_ms, current_end_at_ms, current_duration_ms, current_observed_at_ms,
          current_used_percent, current_quota_bucket_key, current_active_limit,
          detected_at_ms, effective_previous_usage_end_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...eventSqlValues(event));
      const eventId = safeRowId(inserted.lastInsertRowid, 'primary_window_event');

      const advanced = this.db.prepare(`
        UPDATE primary_window_cursor SET
          revision = ?,
          anchor_start_at_ms = ?, anchor_end_at_ms = ?, anchor_duration_ms = ?, anchor_observed_at_ms = ?,
          latest_start_at_ms = ?, latest_end_at_ms = ?, latest_duration_ms = ?, latest_observed_at_ms = ?,
          latest_used_percent = ?, latest_quota_bucket_key = ?, latest_active_limit = ?,
          pending_kind = NULL, pending_start_at_ms = NULL, pending_end_at_ms = NULL,
          pending_duration_ms = NULL, pending_observed_at_ms = NULL,
          pending_first_seen_at_ms = NULL, pending_observation_count = NULL
        WHERE upstream_id = ? AND revision = ? AND pending_first_seen_at_ms = ?
      `).run(
        event.toRevision,
        event.current.startAtMs,
        event.current.endAtMs,
        event.current.durationMs,
        event.current.observedAtMs,
        event.current.startAtMs,
        event.current.endAtMs,
        event.current.durationMs,
        event.current.observedAtMs,
        event.current.usedPercent,
        event.current.quotaBucketKey,
        event.current.activeLimit,
        event.upstreamId,
        expectedRevision,
        candidateFirstSeenAtMs,
      );
      if (advanced.changes !== 1) throw new Error('Cursor changed while committing transition');

      let deliveryCount = 0;
      if (uniqueBindingIds.length > 0) {
        const placeholders = uniqueBindingIds.map(() => '?').join(', ');
        const deliveries = this.db.prepare(`
          INSERT INTO primary_window_delivery (
            event_id, binding_id, status, payload, attempts, next_attempt_at_ms,
            claim_token, claim_until_ms, sent_at_ms, dead_at_ms, last_error,
            created_at_ms, updated_at_ms
          )
          SELECT ?, id, 'pending', NULL, 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?
          FROM bindings
          WHERE id IN (${placeholders}) AND bound_at_ms <= ?
        `).run(
          eventId,
          event.detectedAtMs,
          event.detectedAtMs,
          event.detectedAtMs,
          ...uniqueBindingIds,
          candidateFirstSeenAtMs,
        );
        deliveryCount = Number(deliveries.changes);
      }

      const storedEvent = this.getEvent(eventId);
      if (!storedEvent) throw new Error('Committed event is missing');
      return { status: 'committed', event: storedEvent, deliveryCount };
    });
  }

  getEvent(eventId: number): PrimaryWindowEvent | null {
    const row = this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM primary_window_event WHERE id = ?`)
      .get(eventId) as EventRow | undefined;
    return row ? decodeEvent(row) : null;
  }

  listEvents(upstreamId?: string): PrimaryWindowEvent[] {
    const rows = upstreamId === undefined
      ? this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM primary_window_event ORDER BY id`).all()
      : this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM primary_window_event WHERE upstream_id = ? ORDER BY id`).all(upstreamId);
    return (rows as unknown as EventRow[]).map(decodeEvent);
  }

  claimDueDelivery(input: ClaimDeliveryInput): PrimaryWindowDelivery | null {
    assertTimestamp(input.nowMs, 'claim timestamp');
    assertSafeInteger(input.leaseDurationMs, 'lease duration', 1);
    const token = input.claimToken ?? randomUUID();
    validateText(token, 'claim token');
    const claimUntilMs = input.nowMs + input.leaseDurationMs;
    assertTimestamp(claimUntilMs, 'claim-until timestamp');

    return this.immediateTransaction(() => {
      for (;;) {
        const row = this.db.prepare(`
          SELECT ${DELIVERY_COLUMNS}
          FROM primary_window_delivery
          WHERE (status = 'pending' AND next_attempt_at_ms <= ?)
             OR (status = 'leased' AND claim_until_ms <= ?)
          ORDER BY
            CASE WHEN status = 'pending' THEN next_attempt_at_ms ELSE claim_until_ms END,
            id
          LIMIT 1
        `).get(input.nowMs, input.nowMs) as DeliveryRow | undefined;
        if (!row) return null;

        let deliveryId: number;
        try {
          deliveryId = requireSafeInteger(row.id, 'primary_window_delivery', safeIdentifier(row.id), 1);
          decodeDelivery(row);
        } catch {
          const malformedId = safeOptionalInteger(row.id);
          if (malformedId === null) throw new DatabaseRowError('primary_window_delivery', 'unknown');
          this.db.prepare(`
            UPDATE primary_window_delivery SET
              status = 'dead', claim_token = NULL, claim_until_ms = NULL,
              dead_at_ms = ?, last_error = 'Malformed delivery row', updated_at_ms = ?
            WHERE id = ?
          `).run(input.nowMs, input.nowMs, malformedId);
          continue;
        }

        const claimed = this.db.prepare(`
          UPDATE primary_window_delivery SET
            status = 'leased', attempts = attempts + 1,
            claim_token = ?, claim_until_ms = ?, updated_at_ms = ?
          WHERE id = ?
            AND ((status = 'pending' AND next_attempt_at_ms <= ?)
              OR (status = 'leased' AND claim_until_ms <= ?))
        `).run(token, claimUntilMs, input.nowMs, deliveryId, input.nowMs, input.nowMs);
        if (claimed.changes !== 1) continue;
        return this.getDelivery(deliveryId);
      }
    });
  }

  persistDeliveryPayload(deliveryId: number, claimToken: string, payload: string, nowMs: number): boolean {
    assertDeliveryMutationInput(deliveryId, claimToken, nowMs);
    validateText(payload, 'delivery payload');
    return this.db.prepare(`
      UPDATE primary_window_delivery SET payload = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'leased' AND claim_token = ? AND claim_until_ms > ? AND payload IS NULL
    `).run(payload, nowMs, deliveryId, claimToken, nowMs).changes === 1;
  }

  markDeliverySent(deliveryId: number, claimToken: string, sentAtMs: number): boolean {
    assertDeliveryMutationInput(deliveryId, claimToken, sentAtMs);
    return this.db.prepare(`
      UPDATE primary_window_delivery SET
        status = 'sent', claim_token = NULL, claim_until_ms = NULL,
        sent_at_ms = ?, dead_at_ms = NULL, last_error = NULL, updated_at_ms = ?
      WHERE id = ? AND status = 'leased' AND claim_token = ? AND claim_until_ms > ? AND payload IS NOT NULL
    `).run(sentAtMs, sentAtMs, deliveryId, claimToken, sentAtMs).changes === 1;
  }

  markDeliveryRetry(
    deliveryId: number,
    claimToken: string,
    nextAttemptAtMs: number,
    lastError: string,
    nowMs: number,
  ): boolean {
    assertDeliveryMutationInput(deliveryId, claimToken, nowMs);
    assertTimestamp(nextAttemptAtMs, 'next-attempt timestamp');
    return this.db.prepare(`
      UPDATE primary_window_delivery SET
        status = 'pending', next_attempt_at_ms = ?, claim_token = NULL, claim_until_ms = NULL,
        last_error = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'leased' AND claim_token = ? AND claim_until_ms > ?
    `).run(nextAttemptAtMs, boundedError(lastError), nowMs, deliveryId, claimToken, nowMs).changes === 1;
  }

  markDeliverySkipped(
    deliveryId: number,
    claimToken: string,
    reason: string | null,
    nowMs: number,
  ): boolean {
    assertDeliveryMutationInput(deliveryId, claimToken, nowMs);
    return this.db.prepare(`
      UPDATE primary_window_delivery SET
        status = 'skipped', claim_token = NULL, claim_until_ms = NULL,
        last_error = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'leased' AND claim_token = ? AND claim_until_ms > ?
    `).run(reason === null ? null : boundedError(reason), nowMs, deliveryId, claimToken, nowMs).changes === 1;
  }

  markDeliveryDead(
    deliveryId: number,
    claimToken: string,
    lastError: string,
    deadAtMs: number,
  ): boolean {
    assertDeliveryMutationInput(deliveryId, claimToken, deadAtMs);
    return this.db.prepare(`
      UPDATE primary_window_delivery SET
        status = 'dead', claim_token = NULL, claim_until_ms = NULL,
        dead_at_ms = ?, last_error = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'leased' AND claim_token = ? AND claim_until_ms > ?
    `).run(deadAtMs, boundedError(lastError), deadAtMs, deliveryId, claimToken, deadAtMs).changes === 1;
  }

  getDelivery(deliveryId: number): PrimaryWindowDelivery | null {
    const row = this.db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM primary_window_delivery WHERE id = ?`)
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? decodeDelivery(row) : null;
  }

  listDeliveries(eventId?: number): PrimaryWindowDelivery[] {
    const rows = eventId === undefined
      ? this.db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM primary_window_delivery ORDER BY id`).all()
      : this.db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM primary_window_delivery WHERE event_id = ? ORDER BY id`).all(eventId);
    return (rows as unknown as DeliveryRow[]).map(decodeDelivery);
  }

  purgeTerminalEvents(beforeDetectedAtMs: number, limit = MAX_PURGE_BATCH_SIZE): number {
    assertTimestamp(beforeDetectedAtMs, 'retention cutoff');
    assertSafeInteger(limit, 'purge limit', 1);
    const boundedLimit = Math.min(limit, MAX_PURGE_BATCH_SIZE);
    return this.immediateTransaction(() => Number(this.db.prepare(`
      DELETE FROM primary_window_event
      WHERE id IN (
        SELECT event.id
        FROM primary_window_event AS event
        WHERE event.detected_at_ms < ?
          AND NOT EXISTS (
            SELECT 1 FROM primary_window_delivery AS delivery
            WHERE delivery.event_id = event.id
              AND delivery.status NOT IN ('sent', 'skipped', 'dead')
          )
        ORDER BY event.detected_at_ms, event.id
        LIMIT ?
      )
    `).run(beforeDetectedAtMs, boundedLimit).changes));
  }

  close(): void {
    this.db.close();
  }

  private configureFileDatabase(): void {
    const modeRow = this.db.prepare('PRAGMA journal_mode = WAL').get() as Record<string, unknown> | undefined;
    const mode = modeRow ? Object.values(modeRow)[0] : undefined;
    if (typeof mode !== 'string' || mode.toLowerCase() !== 'wal') {
      throw new Error('Unable to enable WAL journal mode');
    }
    this.db.exec('PRAGMA synchronous = NORMAL');
    if (this.pragmaInteger('synchronous') !== 1) throw new Error('Unable to enable NORMAL synchronous mode');
  }

  private assertConnectionPragmas(): void {
    if (this.pragmaInteger('foreign_keys') !== 1) throw new Error('Unable to enable SQLite foreign keys');
    if (this.pragmaInteger('busy_timeout') !== DATABASE_BUSY_TIMEOUT_MS) {
      throw new Error('Unable to configure SQLite busy timeout');
    }
  }

  private pragmaInteger(name: string): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Unable to read PRAGMA ${name}`);
    return value;
  }

  private decodeBinding(row: BindingRow): Binding {
    const identifier = safeIdentifier(row.id);
    const bindingId = requireSafeInteger(row.id, 'bindings', identifier, 1);
    const telegramUserId = requireText(row.telegram_user_id, 'bindings', identifier);
    const flowayUserId = requireSafeInteger(row.floway_user_id, 'bindings', identifier, 1);
    const username = requireText(row.username, 'bindings', identifier);
    const ciphertext = requireText(row.encrypted_session, 'bindings', identifier);
    const nonce = requireText(row.session_nonce, 'bindings', identifier);
    const boundAtMs = requireTimestamp(row.bound_at_ms, 'bindings', identifier);
    const updatedAtMs = requireTimestamp(row.updated_at_ms, 'bindings', identifier);
    if (updatedAtMs < boundAtMs) throw new DatabaseRowError('bindings', identifier);
    let flowaySession: string;
    try {
      flowaySession = decryptString({ ciphertext, nonce }, this.secretKey);
    } catch {
      throw new DatabaseRowError('bindings', identifier, 'decrypt-failed');
    }
    return {
      bindingId,
      telegramUserId,
      flowayUserId,
      username,
      flowaySession,
      createdAt: timestampPresentation(boundAtMs),
      updatedAt: timestampPresentation(updatedAtMs),
    };
  }

  private cursorMutationResult(
    upstreamId: string,
    expectedRevision: number,
    changes: number,
    candidateSensitive = false,
  ): CursorMutationResult {
    if (changes === 1) {
      const cursor = this.getCursor(upstreamId);
      if (!cursor) throw new Error('Updated cursor is missing');
      return { status: 'updated', cursor };
    }
    const cursor = this.getCursor(upstreamId);
    if (!cursor) return { status: 'missing' };
    if (cursor.revision !== expectedRevision) return { status: 'stale' };
    return { status: candidateSensitive ? 'candidate-mismatch' : 'stale' };
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const decodeCursor = (row: CursorRow): PrimaryWindowCursor => {
  const identifier = typeof row.upstream_id === 'string' ? row.upstream_id : 'unknown';
  const table = 'primary_window_cursor' as const;
  const upstreamId = requireText(row.upstream_id, table, identifier);
  const anchor = decodeAnchor(row, 'anchor', table, identifier);
  const latest: PrimaryWindowFacts = {
    ...decodeAnchor(row, 'latest', table, identifier),
    usedPercent: requireNullablePercent(row.latest_used_percent, table, identifier),
    quotaBucketKey: requireNullableText(row.latest_quota_bucket_key, table, identifier),
    activeLimit: requireNullableText(row.latest_active_limit, table, identifier),
  };
  const pendingValues = [
    row.pending_kind,
    row.pending_start_at_ms,
    row.pending_end_at_ms,
    row.pending_duration_ms,
    row.pending_observed_at_ms,
    row.pending_first_seen_at_ms,
    row.pending_observation_count,
  ];
  let pending: PendingPrimaryWindowCandidate | null = null;
  if (!pendingValues.every(value => value === null)) {
    if (pendingValues.some(value => value === null)
      || (row.pending_kind !== 'natural' && row.pending_kind !== 'manual')) {
      throw new DatabaseRowError(table, identifier);
    }
    pending = {
      kind: row.pending_kind,
      startAtMs: requireTimestamp(row.pending_start_at_ms, table, identifier),
      endAtMs: requireTimestamp(row.pending_end_at_ms, table, identifier),
      durationMs: requireSafeInteger(row.pending_duration_ms, table, identifier, 1),
      observedAtMs: requireTimestamp(row.pending_observed_at_ms, table, identifier),
      firstSeenAtMs: requireTimestamp(row.pending_first_seen_at_ms, table, identifier),
      observationCount: requireSafeInteger(row.pending_observation_count, table, identifier, 1),
    };
    validateDecodedWindow(pending, table, identifier);
  }
  return {
    upstreamId,
    revision: requireSafeInteger(row.revision, table, identifier, 0),
    anchor,
    latest,
    pending,
  };
};

const decodeAnchor = (
  row: CursorRow,
  prefix: 'anchor' | 'latest',
  table: 'primary_window_cursor',
  identifier: string,
): PrimaryWindowAnchor => {
  const anchor = {
    startAtMs: requireTimestamp(row[`${prefix}_start_at_ms`], table, identifier),
    endAtMs: requireTimestamp(row[`${prefix}_end_at_ms`], table, identifier),
    durationMs: requireSafeInteger(row[`${prefix}_duration_ms`], table, identifier, 1),
    observedAtMs: requireTimestamp(row[`${prefix}_observed_at_ms`], table, identifier),
  };
  validateDecodedWindow(anchor, table, identifier);
  return anchor;
};

const decodeEvent = (row: EventRow): PrimaryWindowEvent => {
  const table = 'primary_window_event' as const;
  const identifier = safeIdentifier(row.id);
  if (row.kind !== 'natural' && row.kind !== 'manual') throw new DatabaseRowError(table, identifier);
  const previous = decodeEventFacts(row, 'previous', identifier);
  const current = decodeEventFacts(row, 'current', identifier);
  const effective = requireNullableTimestamp(row.effective_previous_usage_end_at_ms, table, identifier);
  if ((row.kind === 'natural' && effective !== null)
    || (row.kind === 'manual' && (effective === null || effective < previous.startAtMs || effective > previous.endAtMs))) {
    throw new DatabaseRowError(table, identifier);
  }
  const fromRevision = requireSafeInteger(row.from_revision, table, identifier, 0);
  const toRevision = requireSafeInteger(row.to_revision, table, identifier, 1);
  if (toRevision !== fromRevision + 1) throw new DatabaseRowError(table, identifier);
  return {
    eventId: requireSafeInteger(row.id, table, identifier, 1),
    upstreamId: requireText(row.upstream_id, table, identifier),
    fromRevision,
    toRevision,
    upstreamKind: requireText(row.upstream_kind, table, identifier),
    upstreamName: requireText(row.upstream_name, table, identifier),
    kind: row.kind,
    previous,
    current,
    detectedAtMs: requireTimestamp(row.detected_at_ms, table, identifier),
    effectivePreviousUsageEndAtMs: effective,
  };
};

const decodeEventFacts = (row: EventRow, prefix: 'previous' | 'current', identifier: string): PrimaryWindowFacts => {
  const table = 'primary_window_event' as const;
  const facts: PrimaryWindowFacts = {
    startAtMs: requireTimestamp(row[`${prefix}_start_at_ms`], table, identifier),
    endAtMs: requireTimestamp(row[`${prefix}_end_at_ms`], table, identifier),
    durationMs: requireSafeInteger(row[`${prefix}_duration_ms`], table, identifier, 1),
    observedAtMs: requireTimestamp(row[`${prefix}_observed_at_ms`], table, identifier),
    usedPercent: requireNullablePercent(row[`${prefix}_used_percent`], table, identifier),
    quotaBucketKey: requireNullableText(row[`${prefix}_quota_bucket_key`], table, identifier),
    activeLimit: requireNullableText(row[`${prefix}_active_limit`], table, identifier),
  };
  validateDecodedWindow(facts, table, identifier);
  return facts;
};

const decodeDelivery = (row: DeliveryRow): PrimaryWindowDelivery => {
  const table = 'primary_window_delivery' as const;
  const identifier = safeIdentifier(row.id);
  if (!isDeliveryStatus(row.status)) throw new DatabaseRowError(table, identifier);
  const payload = requireNullableText(row.payload, table, identifier);
  const claimToken = requireNullableText(row.claim_token, table, identifier);
  const claimUntilMs = requireNullableTimestamp(row.claim_until_ms, table, identifier);
  const sentAtMs = requireNullableTimestamp(row.sent_at_ms, table, identifier);
  const deadAtMs = requireNullableTimestamp(row.dead_at_ms, table, identifier);
  const lastError = requireNullableString(row.last_error, table, identifier);
  const createdAtMs = requireTimestamp(row.created_at_ms, table, identifier);
  const updatedAtMs = requireTimestamp(row.updated_at_ms, table, identifier);
  if (updatedAtMs < createdAtMs || (lastError !== null && lastError.length > MAX_DELIVERY_ERROR_LENGTH)) {
    throw new DatabaseRowError(table, identifier);
  }
  const shapeIsValid =
    (row.status === 'pending' && claimToken === null && claimUntilMs === null && sentAtMs === null && deadAtMs === null)
    || (row.status === 'leased' && claimToken !== null && claimUntilMs !== null && claimUntilMs >= updatedAtMs && sentAtMs === null && deadAtMs === null)
    || (row.status === 'sent' && payload !== null && claimToken === null && claimUntilMs === null && sentAtMs !== null && deadAtMs === null)
    || (row.status === 'skipped' && claimToken === null && claimUntilMs === null && sentAtMs === null && deadAtMs === null)
    || (row.status === 'dead' && claimToken === null && claimUntilMs === null && sentAtMs === null && deadAtMs !== null);
  if (!shapeIsValid) throw new DatabaseRowError(table, identifier);
  return {
    deliveryId: requireSafeInteger(row.id, table, identifier, 1),
    eventId: requireSafeInteger(row.event_id, table, identifier, 1),
    bindingId: requireSafeInteger(row.binding_id, table, identifier, 1),
    status: row.status,
    payload,
    attempts: requireSafeInteger(row.attempts, table, identifier, 0),
    nextAttemptAtMs: requireTimestamp(row.next_attempt_at_ms, table, identifier),
    claimToken,
    claimUntilMs,
    sentAtMs,
    deadAtMs,
    lastError,
    createdAtMs,
    updatedAtMs,
  };
};

const factsExactlyEqual = (left: PrimaryWindowFacts, right: PrimaryWindowFacts): boolean =>
  left.startAtMs === right.startAtMs
  && left.endAtMs === right.endAtMs
  && left.durationMs === right.durationMs
  && left.observedAtMs === right.observedAtMs
  && Object.is(left.usedPercent, right.usedPercent)
  && left.quotaBucketKey === right.quotaBucketKey
  && left.activeLimit === right.activeLimit;

const eventMatchesPendingCandidate = (
  currentFacts: PrimaryWindowFacts,
  pending: PendingPrimaryWindowCandidate,
): boolean => currentFacts.startAtMs === pending.startAtMs
  && currentFacts.endAtMs === pending.endAtMs
  && currentFacts.durationMs === pending.durationMs
  && currentFacts.observedAtMs === pending.observedAtMs;

const eventSqlValues = (event: NewPrimaryWindowEvent): SQLInputValue[] => [
  event.upstreamId,
  event.fromRevision,
  event.toRevision,
  event.upstreamKind,
  event.upstreamName,
  event.kind,
  ...factsSqlValues(event.previous),
  ...factsSqlValues(event.current),
  event.detectedAtMs,
  event.effectivePreviousUsageEndAtMs,
];

const factsSqlValues = (facts: PrimaryWindowFacts): SQLInputValue[] => [
  facts.startAtMs,
  facts.endAtMs,
  facts.durationMs,
  facts.observedAtMs,
  facts.usedPercent,
  facts.quotaBucketKey,
  facts.activeLimit,
];

const validateBindingInput = (input: { telegramUserId: string; flowayUserId: number; username: string; flowaySession: string }): void => {
  validateText(input.telegramUserId, 'Telegram user id');
  assertSafeInteger(input.flowayUserId, 'Floway user id', 1);
  validateUsername(input.username);
  validateText(input.flowaySession, 'Floway session');
};

const validateUsername = (username: string): void => validateText(username, 'Floway username');

const validateFacts = (facts: PrimaryWindowFacts): void => {
  validateWindow(facts);
  if (facts.usedPercent !== null
    && (typeof facts.usedPercent !== 'number' || !Number.isFinite(facts.usedPercent)
      || facts.usedPercent < 0 || facts.usedPercent > 100)) {
    throw new TypeError('Used percent must be null or a finite number from 0 through 100');
  }
  validateNullableText(facts.quotaBucketKey, 'quota bucket key');
  validateNullableText(facts.activeLimit, 'active limit');
};

const validatePendingCandidate = (candidate: PendingPrimaryWindowCandidate): void => {
  if (candidate.kind !== 'natural' && candidate.kind !== 'manual') throw new TypeError('Invalid transition kind');
  validateWindow(candidate);
  assertTimestamp(candidate.firstSeenAtMs, 'candidate first-seen timestamp');
  assertSafeInteger(candidate.observationCount, 'candidate observation count', 1);
};

const validateEvent = (event: NewPrimaryWindowEvent): void => {
  validateText(event.upstreamId, 'upstream id');
  assertSafeInteger(event.fromRevision, 'event from revision', 0);
  assertSafeInteger(event.toRevision, 'event to revision', 1);
  if (event.toRevision !== event.fromRevision + 1) throw new TypeError('Event revisions must be consecutive');
  validateText(event.upstreamKind, 'upstream kind');
  validateText(event.upstreamName, 'upstream name');
  if (event.kind !== 'natural' && event.kind !== 'manual') throw new TypeError('Invalid transition kind');
  validateFacts(event.previous);
  validateFacts(event.current);
  assertTimestamp(event.detectedAtMs, 'event detection timestamp');
  if (event.kind === 'natural' && event.effectivePreviousUsageEndAtMs !== null) {
    throw new TypeError('Natural transitions cannot override the previous usage end');
  }
  if (event.kind === 'manual') {
    if (event.effectivePreviousUsageEndAtMs === null) throw new TypeError('Manual transitions require a previous usage end');
    assertTimestamp(event.effectivePreviousUsageEndAtMs, 'effective previous usage end');
    if (event.effectivePreviousUsageEndAtMs < event.previous.startAtMs
      || event.effectivePreviousUsageEndAtMs > event.previous.endAtMs) {
      throw new TypeError('Effective previous usage end is outside the previous window');
    }
  }
};

const validateWindow = (window: PrimaryWindowAnchor): void => {
  assertTimestamp(window.startAtMs, 'window start');
  assertTimestamp(window.endAtMs, 'window end');
  assertSafeInteger(window.durationMs, 'window duration', 1);
  assertTimestamp(window.observedAtMs, 'observation timestamp');
  if (window.endAtMs <= window.startAtMs || window.durationMs !== window.endAtMs - window.startAtMs) {
    throw new TypeError('Window duration must exactly match its boundaries');
  }
};

const validateDecodedWindow = (
  window: PrimaryWindowAnchor,
  table: 'primary_window_cursor' | 'primary_window_event',
  identifier: string,
): void => {
  if (window.endAtMs <= window.startAtMs || window.durationMs !== window.endAtMs - window.startAtMs) {
    throw new DatabaseRowError(table, identifier);
  }
};

const assertDeliveryMutationInput = (deliveryId: number, claimToken: string, nowMs: number): void => {
  assertSafeInteger(deliveryId, 'delivery id', 1);
  validateText(claimToken, 'claim token');
  assertTimestamp(nowMs, 'delivery timestamp');
};

const boundedError = (value: string): string => {
  if (typeof value !== 'string') throw new TypeError('Delivery error must be a string');
  return value.slice(0, MAX_DELIVERY_ERROR_LENGTH);
};

const safeRowId = (value: number | bigint, table: string): number => {
  const converted = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted < 1) throw new Error(`Invalid row id returned for ${table}`);
  return converted;
};

const safeIdentifier = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return String(value);
  return 'unknown';
};

const safeOptionalInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
};

const assertSafeInteger = (value: number, name: string, minimum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer of at least ${minimum}`);
};

const assertTimestamp = (value: number, name: string): void => {
  assertSafeInteger(value, name, 0);
  if (value > MAX_TIMESTAMP_MS) throw new TypeError(`${name} is outside the supported timestamp range`);
};

const requireSafeInteger = (
  value: unknown,
  table: DatabaseRowError['table'],
  identifier: string,
  minimum: number,
): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new DatabaseRowError(table, identifier);
  }
  return value;
};

const requireTimestamp = (value: unknown, table: DatabaseRowError['table'], identifier: string): number => {
  const timestamp = requireSafeInteger(value, table, identifier, 0);
  if (timestamp > MAX_TIMESTAMP_MS) throw new DatabaseRowError(table, identifier);
  return timestamp;
};

const requireNullableTimestamp = (value: unknown, table: DatabaseRowError['table'], identifier: string): number | null =>
  value === null ? null : requireTimestamp(value, table, identifier);

const requireText = (value: unknown, table: DatabaseRowError['table'], identifier: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new DatabaseRowError(table, identifier);
  return value;
};

const requireNullableText = (value: unknown, table: DatabaseRowError['table'], identifier: string): string | null =>
  value === null ? null : requireText(value, table, identifier);

const requireNullableString = (value: unknown, table: DatabaseRowError['table'], identifier: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new DatabaseRowError(table, identifier);
  return value;
};

const requireNullablePercent = (value: unknown, table: DatabaseRowError['table'], identifier: string): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new DatabaseRowError(table, identifier);
  }
  return value;
};

const validateText = (value: string, name: string): void => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must not be empty`);
};

const validateNullableText = (value: string | null, name: string): void => {
  if (value !== null) validateText(value, name);
};

const timestampPresentation = (value: number): string => new Date(value).toISOString();

const isDeliveryStatus = (value: unknown): value is DeliveryStatus =>
  value === 'pending' || value === 'leased' || value === 'sent' || value === 'skipped' || value === 'dead';
