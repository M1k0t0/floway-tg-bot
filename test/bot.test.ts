import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Telegram } from 'telegraf';
import { describe, expect, it, vi } from 'vitest';

import {
  BOT_COMMANDS,
  createBot,
  TEST_QUOTA_WINDOW_COMMAND,
  canShareUpstreamQuota,
  filterUpstreamsForUser,
  parseLeaderboardArgs,
  parseNewKeyArgs,
  parseQuotaArgs,
  selectUpstream,
} from '../src/bot.js';
import { BindingStore } from '../src/db.js';
import { FlowayHttpError, type FlowayClient } from '../src/floway-client.js';
import type { AppConfig, UpstreamRecord } from '../src/types.js';

const upstream = (id: string): UpstreamRecord => ({
  id,
  kind: 'codex',
  name: id,
  enabled: true,
  sort_order: 0,
  created_at: '2026-06-21T00:00:00.000Z',
  updated_at: '2026-06-21T00:00:00.000Z',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  color: null,
  config: {},
  state: null,
});

describe('bot commands', () => {
  it('keeps the quota window test command hidden from the Telegram command list', () => {
    expect(BOT_COMMANDS.map(command => command.command)).not.toContain(TEST_QUOTA_WINDOW_COMMAND);
  });

  it('loads the full record before invoking the unified upstream model action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'floway-bot-command-'));
    const store = new BindingStore(join(dir, 'bot.sqlite'), randomBytes(32));
    const listed = upstream('up_a');
    const full = {
      ...listed,
      config: { apiKey: 'provider-secret' },
      state: { accessToken: 'state-secret' },
    };
    const getUpstreamModels = vi.fn().mockResolvedValue({ data: [] });
    const floway = {
      getMe: vi.fn().mockResolvedValue({
        user: { id: 7, username: 'alice', isAdmin: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      listUpstreams: vi.fn().mockResolvedValue([listed]),
      getUpstream: vi.fn().mockResolvedValue(full),
      getUpstreamModels,
      getCopilotQuota: vi.fn(),
    } as unknown as FlowayClient;
    const config = {
      telegramBotToken: '123:test',
      flowayBaseUrl: 'https://floway.example',
      flowayAdminKey: 'admin-secret',
      botDbPath: join(dir, 'bot.sqlite'),
      botSecretKey: randomBytes(32),
      usageExportCacheTtlSeconds: 30,
      quotaWindowNotifyIntervalSeconds: 300,
    } satisfies AppConfig;
    store.replaceBinding({
      telegramUserId: '42',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'user-session',
    });
    const bot = createBot(config, store, floway);
    bot.botInfo = {
      id: 123,
      is_bot: true,
      first_name: 'Floway',
      username: 'floway_test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
    const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({} as never);

    try {
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 42, type: 'private', first_name: 'Alice' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: '/upstream up_a',
          entities: [{ offset: 0, length: 9, type: 'bot_command' }],
        },
      });

      expect(floway.getUpstream).toHaveBeenCalledWith('up_a');
      expect(getUpstreamModels).toHaveBeenCalledWith(full);
      expect(floway.getCopilotQuota).not.toHaveBeenCalled();
      const reply = callApi.mock.calls.find(([method]) => method === 'sendMessage');
      expect(reply?.[1]).toMatchObject({ text: expect.stringContaining('Models (0)') });
      expect(JSON.stringify(reply?.[1])).not.toContain('provider-secret');
      expect(JSON.stringify(reply?.[1])).not.toContain('state-secret');
    } finally {
      callApi.mockRestore();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the latest-reset quota slot for the usage command', async () => {
    const fixture = createCommandFixture();
    fixture.store.replaceBinding({
      telegramUserId: '42',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session',
    });
    const selected = {
      ...upstream('up_a'),
      codex_quota: {
        plus: {
          observed_at: '2026-07-01T01:00:00.000Z',
          active_limit: 'premium',
          primary_window_minutes: 300,
          primary_reset_after_at: '2026-07-01T05:00:00.000Z',
          primary_used_percent: 15,
          secondary_window_minutes: 10_080,
          secondary_reset_after_at: '2026-07-08T00:00:00.000Z',
          secondary_used_percent: 75,
        },
      },
    } satisfies UpstreamRecord;
    const floway = {
      getMe: vi.fn().mockResolvedValue({
        user: { id: 7, username: 'alice', isAdmin: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      listUpstreams: vi.fn().mockResolvedValue([selected]),
      exportUsageSnapshot: vi.fn().mockResolvedValue({
        exportedAt: '2026-07-01T01:00:00.000Z',
        users: [{ id: 7, username: 'alice', deletedAt: null }],
        apiKeys: [],
        usage: [],
      }),
    } as unknown as FlowayClient;
    const bot = configuredBot(fixture, floway);
    const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({} as never);

    try {
      await bot.handleUpdate(commandUpdate('/usage up_a', 4));

      const text = sentTexts(callApi).join('\n');
      expect(text).toContain('<b>Quota window — premium</b>');
      expect(text).toContain('<code>2026-07-01T00:00:00.000Z</code>');
      expect(text).toContain('<code>2026-07-08T00:00:00.000Z</code>');
      expect(text).toContain('<b>Floway upstream used</b>: <b>75.0%</b>');
      expect(text).not.toContain('15.0%');
    } finally {
      callApi.mockRestore();
      fixture.close();
    }
  });

  it('keeps a newer binding when unbind finishes an older logout', async () => {
    const fixture = createCommandFixture();
    const old = fixture.store.replaceBinding({ telegramUserId: '42', flowayUserId: 7, username: 'alice', flowaySession: 'old' });
    const logout = deferred<{ ok: true }>();
    const floway = { logout: vi.fn(() => logout.promise) } as unknown as FlowayClient;
    const bot = configuredBot(fixture, floway);
    const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({} as never);

    try {
      const update = bot.handleUpdate(commandUpdate('/unbind', 1));
      await vi.waitFor(() => expect(floway.logout).toHaveBeenCalledWith('old'));
      const current = fixture.store.replaceBinding({ telegramUserId: '42', flowayUserId: 7, username: 'alice', flowaySession: 'new' });
      logout.resolve({ ok: true });
      await update;

      expect(fixture.store.getByTelegramUserId('42')).toMatchObject({ bindingId: current.bindingId, flowaySession: 'new' });
      expect(current.bindingId).toBeGreaterThan(old.bindingId);
      expect(sentTexts(callApi)).toContain('Binding changed while signing out; the newer binding was kept.');
    } finally {
      callApi.mockRestore();
      fixture.close();
    }
  });

  it('does not let an older metadata refresh overwrite a newer binding', async () => {
    const fixture = createCommandFixture();
    fixture.store.replaceBinding({ telegramUserId: '42', flowayUserId: 7, username: 'alice', flowaySession: 'old' });
    const me = deferred<Awaited<ReturnType<FlowayClient['getMe']>>>();
    const floway = { getMe: vi.fn(() => me.promise) } as unknown as FlowayClient;
    const bot = configuredBot(fixture, floway);
    const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({} as never);

    try {
      const update = bot.handleUpdate(commandUpdate('/me', 2));
      await vi.waitFor(() => expect(floway.getMe).toHaveBeenCalledWith('old'));
      const current = fixture.store.replaceBinding({ telegramUserId: '42', flowayUserId: 8, username: 'bob', flowaySession: 'new' });
      me.resolve({
        user: { id: 7, username: 'alice-renamed', isAdmin: false, upstreamIds: null },
        viaApiKey: false,
        apiKey: null,
      });
      await update;

      expect(fixture.store.getByTelegramUserId('42')).toMatchObject({ bindingId: current.bindingId, flowayUserId: 8, flowaySession: 'new' });
      expect(sentTexts(callApi)).toContain('Binding changed while the request was running. Try the command again.');
    } finally {
      callApi.mockRestore();
      fixture.close();
    }
  });

  it('does not let an older 401 delete a newer binding', async () => {
    const fixture = createCommandFixture();
    fixture.store.replaceBinding({ telegramUserId: '42', flowayUserId: 7, username: 'alice', flowaySession: 'old' });
    const me = deferred<Awaited<ReturnType<FlowayClient['getMe']>>>();
    const floway = { getMe: vi.fn(() => me.promise) } as unknown as FlowayClient;
    const bot = configuredBot(fixture, floway);
    const callApi = vi.spyOn(Telegram.prototype, 'callApi').mockResolvedValue({} as never);

    try {
      const update = bot.handleUpdate(commandUpdate('/me', 3));
      await vi.waitFor(() => expect(floway.getMe).toHaveBeenCalledWith('old'));
      const current = fixture.store.replaceBinding({ telegramUserId: '42', flowayUserId: 8, username: 'bob', flowaySession: 'new' });
      me.reject(new FlowayHttpError(401, 'expired'));
      await update;

      expect(fixture.store.getByTelegramUserId('42')).toMatchObject({ bindingId: current.bindingId, flowayUserId: 8, flowaySession: 'new' });
      expect(sentTexts(callApi)).toContain('Binding changed while the request was running. Try the command again.');
    } finally {
      callApi.mockRestore();
      fixture.close();
    }
  });
});

describe('parseNewKeyArgs', () => {
  const upstreams = [upstream('up_a'), upstream('up_b')];

  it('keeps multi-word names when no scope is present', () => {
    expect(parseNewKeyArgs('my test key', upstreams)).toEqual({
      name: 'my test key',
      upstreamIds: null,
    });
  });

  it('parses all scope', () => {
    expect(parseNewKeyArgs('my test key all', upstreams)).toEqual({
      name: 'my test key',
      upstreamIds: null,
    });
  });

  it('parses comma-scoped upstream ids', () => {
    expect(parseNewKeyArgs('my test key up_a,up_b', upstreams)).toEqual({
      name: 'my test key',
      upstreamIds: ['up_a', 'up_b'],
    });
  });

  it('rejects unknown scoped upstreams', () => {
    expect(parseNewKeyArgs('key up_missing', upstreams)).toEqual({
      error: 'Unknown upstream: up_missing',
    });
  });
});

describe('parseLeaderboardArgs', () => {
  it('defaults to 7d and accepts the supported windows', () => {
    expect(parseLeaderboardArgs('')).toEqual({ days: 7 });
    expect(parseLeaderboardArgs('1')).toEqual({ days: 1 });
    expect(parseLeaderboardArgs('1d')).toEqual({ days: 1 });
    expect(parseLeaderboardArgs('7d')).toEqual({ days: 7 });
    expect(parseLeaderboardArgs('30')).toEqual({ days: 30 });
    expect(parseLeaderboardArgs('30D')).toEqual({ days: 30 });
  });

  it('rejects unsupported windows', () => {
    expect(parseLeaderboardArgs('14d')).toEqual({ error: 'Usage: /leaderboard [1d|7d|30d]' });
  });
});

describe('parseQuotaArgs', () => {
  it('defaults to compact output and parses verbose as a subcommand', () => {
    expect(parseQuotaArgs('')).toEqual({ upstreamId: '', verbose: false });
    expect(parseQuotaArgs('up_a')).toEqual({ upstreamId: 'up_a', verbose: false });
    expect(parseQuotaArgs('verbose')).toEqual({ upstreamId: '', verbose: true });
    expect(parseQuotaArgs('verbose up_a')).toEqual({ upstreamId: 'up_a', verbose: true });
  });

  it('rejects extra quota arguments', () => {
    expect(parseQuotaArgs('up_a verbose')).toEqual({ error: 'Usage: /quota [verbose] <upstream_id>' });
    expect(parseQuotaArgs('verbose up_a extra')).toEqual({ error: 'Usage: /quota [verbose] <upstream_id>' });
  });
});

describe('upstream permission filtering', () => {
  const upstreams = [upstream('up_a'), upstream('up_b'), upstream('up_c')];

  it('keeps all upstreams for users with unrestricted upstream access', () => {
    expect(filterUpstreamsForUser(upstreams, { upstreamIds: null }).map(item => item.id)).toEqual(['up_a', 'up_b', 'up_c']);
  });

  it('keeps only upstreams listed on the bound user', () => {
    expect(filterUpstreamsForUser(upstreams, { upstreamIds: ['up_b'] }).map(item => item.id)).toEqual(['up_b']);
  });

  it('hides explicitly requested upstreams outside the bound user access list', () => {
    const allowed = filterUpstreamsForUser(upstreams, { upstreamIds: ['up_a'] });
    expect(selectUpstream('up_b', allowed, 'usage')).toEqual({ message: 'Upstream not found: up_b' });
  });
});

describe('quota sharing users', () => {
  it('counts only non-admin users who can access the selected upstream', () => {
    expect(canShareUpstreamQuota({ isAdmin: false, upstreamIds: null }, 'up_a')).toBe(true);
    expect(canShareUpstreamQuota({ isAdmin: false, upstreamIds: ['up_a'] }, 'up_a')).toBe(true);
    expect(canShareUpstreamQuota({ isAdmin: false, upstreamIds: ['up_b'] }, 'up_a')).toBe(false);
    expect(canShareUpstreamQuota({ isAdmin: true, upstreamIds: null }, 'up_a')).toBe(false);
  });
});

describe('selectUpstream', () => {
  it('auto-selects when there is exactly one upstream and no id was provided', () => {
    const only = upstream('up_only');
    expect(selectUpstream('', [only], 'usage')).toEqual({ upstream: only });
  });

  it('asks for an upstream id when more than one upstream exists', () => {
    const selected = selectUpstream('', [upstream('up_a'), upstream('up_b')], 'upstream');
    expect('message' in selected ? selected.message : '').toContain('/upstream &lt;upstream_id&gt;');
    expect('message' in selected ? selected.message : '').toContain('<code>up_a</code>');
  });

  it('selects the requested upstream id', () => {
    const first = upstream('up_a');
    const second = upstream('up_b');
    expect(selectUpstream('up_b', [first, second], 'usage')).toEqual({ upstream: second });
  });
});

interface CommandFixture {
  store: BindingStore;
  config: AppConfig;
  close(): void;
}

const createCommandFixture = (): CommandFixture => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-bot-race-'));
  const dbPath = join(dir, 'bot.sqlite');
  const store = new BindingStore(dbPath, randomBytes(32));
  return {
    store,
    config: {
      telegramBotToken: '123:test',
      flowayBaseUrl: 'https://floway.example',
      flowayAdminKey: 'admin-secret',
      botDbPath: dbPath,
      botSecretKey: randomBytes(32),
      usageExportCacheTtlSeconds: 30,
      quotaWindowNotifyIntervalSeconds: 300,
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const configuredBot = (fixture: CommandFixture, floway: FlowayClient) => {
  const bot = createBot(fixture.config, fixture.store, floway);
  bot.botInfo = {
    id: 123,
    is_bot: true,
    first_name: 'Floway',
    username: 'floway_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  return bot;
};

const commandUpdate = (text: string, updateId: number) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: 42, type: 'private' as const, first_name: 'Alice' },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
    text,
    entities: [{ offset: 0, length: text.split(/\s/, 1)[0]!.length, type: 'bot_command' as const }],
  },
});

const sentTexts = (callApi: { mock: { calls: readonly (readonly unknown[])[] } }): string[] =>
  callApi.mock.calls
    .filter(call => call[0] === 'sendMessage')
    .map(call => {
      const payload = call[1];
      return typeof payload === 'object' && payload !== null && 'text' in payload
        ? String((payload as { text: unknown }).text)
        : '';
    });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};
