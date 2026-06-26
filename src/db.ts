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

interface SecondaryWindowStateRow {
  telegram_user_id: string;
  upstream_id: string;
  window_start_at: string;
  reset_after_at: string;
  used_percent: number | null;
  updated_at: string;
}

export interface SecondaryWindowState {
  telegramUserId: string;
  upstreamId: string;
  windowStartAt: string;
  resetAfterAt: string;
  usedPercent: number | null;
  updatedAt: string;
}

export class BindingStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly secretKey: Buffer,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secondary_window_state (
        telegram_user_id TEXT NOT NULL,
        upstream_id TEXT NOT NULL,
        window_start_at TEXT NOT NULL,
        reset_after_at TEXT NOT NULL,
        used_percent REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id, upstream_id)
      )
    `);
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
    this.db.prepare('DELETE FROM secondary_window_state WHERE telegram_user_id = ?').run(telegramUserId);
    const result = this.db.prepare('DELETE FROM bindings WHERE telegram_user_id = ?').run(telegramUserId);
    return result.changes > 0;
  }

  getSecondaryWindowState(telegramUserId: string, upstreamId: string): SecondaryWindowState | null {
    const row = this.db
      .prepare('SELECT telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, updated_at FROM secondary_window_state WHERE telegram_user_id = ? AND upstream_id = ?')
      .get(telegramUserId, upstreamId) as SecondaryWindowStateRow | undefined;
    return row ? secondaryWindowStateFromRow(row) : null;
  }

  upsertSecondaryWindowState(input: Omit<SecondaryWindowState, 'updatedAt'>): SecondaryWindowState {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO secondary_window_state (telegram_user_id, upstream_id, window_start_at, reset_after_at, used_percent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (telegram_user_id, upstream_id) DO UPDATE SET
          window_start_at = excluded.window_start_at,
          reset_after_at = excluded.reset_after_at,
          used_percent = excluded.used_percent,
          updated_at = excluded.updated_at
      `)
      .run(input.telegramUserId, input.upstreamId, input.windowStartAt, input.resetAfterAt, input.usedPercent, now);
    return { ...input, updatedAt: now };
  }

  deleteSecondaryWindowState(telegramUserId: string, upstreamId: string): void {
    this.db
      .prepare('DELETE FROM secondary_window_state WHERE telegram_user_id = ? AND upstream_id = ?')
      .run(telegramUserId, upstreamId);
  }

  deleteSecondaryWindowStatesExcept(telegramUserId: string, upstreamIds: readonly string[]): void {
    if (upstreamIds.length === 0) {
      this.db.prepare('DELETE FROM secondary_window_state WHERE telegram_user_id = ?').run(telegramUserId);
      return;
    }
    const placeholders = upstreamIds.map(() => '?').join(', ');
    this.db
      .prepare(`DELETE FROM secondary_window_state WHERE telegram_user_id = ? AND upstream_id NOT IN (${placeholders})`)
      .run(telegramUserId, ...upstreamIds);
  }

  close(): void {
    this.db.close();
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

const secondaryWindowStateFromRow = (row: SecondaryWindowStateRow): SecondaryWindowState => ({
  telegramUserId: row.telegram_user_id,
  upstreamId: row.upstream_id,
  windowStartAt: row.window_start_at,
  resetAfterAt: row.reset_after_at,
  usedPercent: row.used_percent,
  updatedAt: row.updated_at,
});
