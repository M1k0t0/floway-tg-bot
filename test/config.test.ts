import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('defaults and parses the quota window notification interval', () => {
    configureRequiredEnvironment();
    vi.stubEnv('QUOTA_WINDOW_NOTIFY_INTERVAL_SECONDS', '');
    expect(loadConfig().quotaWindowNotifyIntervalSeconds).toBe(300);

    vi.stubEnv('QUOTA_WINDOW_NOTIFY_INTERVAL_SECONDS', '17');
    expect(loadConfig().quotaWindowNotifyIntervalSeconds).toBe(17);
  });

  it('rejects invalid quota window notification intervals by the new environment name', () => {
    configureRequiredEnvironment();
    vi.stubEnv('QUOTA_WINDOW_NOTIFY_INTERVAL_SECONDS', '0');

    expect(() => loadConfig()).toThrow('QUOTA_WINDOW_NOTIFY_INTERVAL_SECONDS must be a positive integer');
  });
});

const configureRequiredEnvironment = (): void => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-config-test-'));
  tempDirs.push(dir);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:test');
  vi.stubEnv('FLOWAY_BASE_URL', 'https://floway.example');
  vi.stubEnv('FLOWAY_ADMIN_KEY', 'admin-secret');
  vi.stubEnv('BOT_DB_PATH', join(dir, 'data', 'bot.sqlite'));
  vi.stubEnv('BOT_SECRET_KEY', randomBytes(32).toString('base64'));
};
