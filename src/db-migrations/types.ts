import type { DatabaseSync } from 'node:sqlite';

export interface DatabaseMigrationContext {
  nowMs: number;
}

export interface DatabaseMigration {
  version: number;
  name: string;
  up(db: DatabaseSync, context: DatabaseMigrationContext): void;
  verify(db: DatabaseSync): void;
}
