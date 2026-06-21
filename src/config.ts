import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { AppConfig } from './types.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const parseSecretKey = (raw: string): Buffer => {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) {
    throw new Error('BOT_SECRET_KEY must be base64 for exactly 32 bytes; generate with `openssl rand -base64 32`');
  }
  return bytes;
};

const parsePositiveInteger = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const loadConfig = (): AppConfig => {
  const botDbPath = resolve(process.env.BOT_DB_PATH || './data/bot.sqlite');
  mkdirSync(dirname(botDbPath), { recursive: true });

  return {
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    flowayBaseUrl: required('FLOWAY_BASE_URL').replace(/\/+$/, ''),
    flowayAdminKey: required('FLOWAY_ADMIN_KEY'),
    botDbPath,
    botSecretKey: parseSecretKey(required('BOT_SECRET_KEY')),
    usageExportCacheTtlSeconds: parsePositiveInteger(process.env.USAGE_EXPORT_CACHE_TTL_SECONDS, 30, 'USAGE_EXPORT_CACHE_TTL_SECONDS'),
  };
};
