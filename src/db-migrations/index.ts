import type { DatabaseSync } from 'node:sqlite';

import { initializeDatabaseMigration } from './0001-initialize.js';
import type { DatabaseMigration } from './types.js';

const migrations: readonly DatabaseMigration[] = [initializeDatabaseMigration];

validateMigrationRegistry(migrations);

export const CURRENT_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export const applyMigrations = (db: DatabaseSync): void => applyMigrationRegistry(db, migrations);

export const applyMigrationRegistry = (db: DatabaseSync, registry: readonly DatabaseMigration[]): void => {
  validateMigrationRegistry(registry);
  const currentVersion = registry.at(-1)?.version ?? 0;
  let version = pragmaInteger(db, 'user_version');
  assertSupportedVersion(version, currentVersion);

  while (version < currentVersion) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = pragmaInteger(db, 'user_version');
      assertSupportedVersion(lockedVersion, currentVersion);
      if (lockedVersion >= currentVersion) {
        db.exec('COMMIT');
        version = lockedVersion;
        continue;
      }

      const migration = registry[lockedVersion];
      if (!migration || migration.version !== lockedVersion + 1) {
        throw new Error(`No database migration is registered for version ${lockedVersion + 1}`);
      }
      migration.up(db, { nowMs: Date.now() });
      migration.verify(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      if (pragmaInteger(db, 'user_version') !== migration.version) {
        throw new Error(`Failed to persist database schema version ${migration.version}`);
      }
      db.exec('COMMIT');
      version = migration.version;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back a failed schema transaction.
      }
      throw error;
    }
  }

  const current = registry.at(-1);
  if (current) current.verify(db);
};

export const validateMigrationRegistry = (registry: readonly DatabaseMigration[]): void => {
  for (let index = 0; index < registry.length; index += 1) {
    const migration = registry[index];
    const expectedVersion = index + 1;
    if (!migration || migration.version !== expectedVersion || migration.name.length === 0) {
      throw new Error(`Database migration registry must contain contiguous versions starting at 1; expected ${expectedVersion}`);
    }
  }
};

const assertSupportedVersion = (version: number, currentVersion: number): void => {
  if (version > currentVersion) {
    throw new Error(`Database schema version ${version} is newer than supported version ${currentVersion}`);
  }
};

const pragmaInteger = (db: DatabaseSync, name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Unable to read PRAGMA ${name}`);
  return value;
};
