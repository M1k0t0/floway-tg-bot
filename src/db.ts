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
  }

  get(telegramUserId: string): Binding | null {
    const row = this.db
      .prepare('SELECT telegram_user_id, floway_user_id, username, encrypted_session, session_nonce, created_at, updated_at FROM bindings WHERE telegram_user_id = ?')
      .get(telegramUserId) as BindingRow | undefined;
    if (!row) return null;
    return {
      telegramUserId: row.telegram_user_id,
      flowayUserId: row.floway_user_id,
      username: row.username,
      flowaySession: decryptString({ ciphertext: row.encrypted_session, nonce: row.session_nonce }, this.secretKey),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
    const result = this.db.prepare('DELETE FROM bindings WHERE telegram_user_id = ?').run(telegramUserId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
