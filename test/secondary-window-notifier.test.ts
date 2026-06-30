import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BindingStore } from '../src/db.js';
import { SecondaryWindowNotifier } from '../src/secondary-window-notifier.js';
import type { SanitizedExportSnapshot, UpstreamRecord } from '../src/types.js';

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('SecondaryWindowNotifier', () => {
  it('seeds current secondary windows, then notifies once after the reset advances', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });

    let currentUpstream = upstreamWithSecondaryReset('2026-06-22T00:00:00.000Z', 80);
    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-22T00:05:00.000Z',
      users: [
        { id: 7, username: 'alice', deletedAt: null },
        { id: 8, username: 'bob', deletedAt: null },
      ],
      apiKeys: [
        { id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'key_b', userId: 8, name: 'Bob key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null },
      ],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 2, tokens: { input: 100 }, cost: { input: 1 } },
        { keyId: 'key_a', model: 'm', upstream: 'up_b', modelKey: 'm', hour: '2026-06-21T12', requests: 9, tokens: { input: 999 }, cost: { input: 1 } },
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-22T00', requests: 1, tokens: { input: 50 }, cost: { input: 1 } },
        { keyId: 'key_b', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-22T00', requests: 3, tokens: { input: 150 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
        { id: 8, username: 'bob', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: null, createdAt: '2026-06-15T00:00:00.000Z' },
        { id: 9, username: 'admin', isAdmin: true, canViewGlobalTelemetry: true, upstreamIds: null, createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return snapshot;
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(exportCalls).toBe(0);
    expect(messages).toEqual([]);

    vi.setSystemTime(new Date('2026-06-22T00:01:00.000Z'));
    currentUpstream = upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 12);
    await notifier.pollOnce();
    await notifier.pollOnce();

    expect(exportCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ chatId: '12345' });
    expect(messages[0]!.text).toContain('<b>Secondary window refreshed</b>');
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:00:00.000Z</code> -> <code>2026-06-22T00:00:00.000Z</code>');
    expect(messages[0]!.text).toContain('<b>Your upstream tokens</b>: <b>100</b>');
    expect(messages[0]!.text).toContain('<b>Upstream cost</b>: <b>$0.000100</b> / $0.000100');
    expect(messages[0]!.text).toContain('<b>Upstream secondary used</b>:\n[||||||||||||   ] <b>80.0%</b>');
    expect(messages[0]!.text).toContain('<b>Estimated your used</b>:');
    expect(messages[0]!.text).toContain('(Assumed 2 users)');
    expect(messages[0]!.text).not.toContain('<b>12.0%</b>');
    expect(messages[0]!.text).not.toContain('<b>Your share by tokens</b>');
    expect(messages[0]!.text).not.toContain('<b>Your share by requests</b>');
    expect(messages[0]!.text).not.toContain('<b>Your upstream cost</b>');
    expect(messages[0]!.text).not.toContain('<b>All upstream cost</b>');
    expect(messages[0]!.text).not.toContain('<b>Quota estimate</b>');
    expect(messages[0]!.text).not.toContain('Reset in ');
    expect(messages[0]!.text).not.toContain('Estimate only');
    expect(messages[0]!.text).not.toContain('999');
  });

  it('sends a catch-up notification when state is missing after the current secondary window started', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));

    const currentUpstream = upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 18);
    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-23T00:05:00.000Z',
      users: [
        { id: 7, username: 'alice', deletedAt: null },
        { id: 8, username: 'bob', deletedAt: null },
      ],
      apiKeys: [
        { id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'key_b', userId: 8, name: 'Bob key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null },
      ],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 4, tokens: { input: 200 }, cost: { input: 1 } },
        { keyId: 'key_b', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 6, tokens: { input: 300 }, cost: { input: 1 } },
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-22T00', requests: 2, tokens: { input: 60 }, cost: { input: 1 } },
        { keyId: 'key_b', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-22T00', requests: 1, tokens: { input: 40 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
        { id: 8, username: 'bob', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: null, createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return snapshot;
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();
    await notifier.pollOnce();

    expect(exportCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ chatId: '12345' });
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:00:00.000Z</code> -> <code>2026-06-22T00:00:00.000Z</code>');
    expect(messages[0]!.text).toContain('<b>Your upstream tokens</b>: <b>200</b>');
    expect(messages[0]!.text).toContain('<b>All upstream tokens</b>: <b>500</b>');
    expect(messages[0]!.text).toContain('Secondary quota estimate unavailable.');
    expect(messages[0]!.text).not.toContain('<b>18.0%</b>');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('sends a catch-up notification from stale Floway quota when state is missing after reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));

    const currentUpstream = upstreamWithSecondaryReset('2026-06-22T00:00:00.000Z', 80);
    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-23T00:05:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 4, tokens: { input: 200 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return snapshot;
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();
    await notifier.pollOnce();

    expect(exportCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:00:00.000Z</code> -> <code>2026-06-22T00:00:00.000Z</code>');
    expect(messages[0]!.text).toContain('<b>Upstream secondary used</b>:\n[||||||||||||   ] <b>80.0%</b>');
    expect(messages[0]!.text).not.toContain('Secondary quota estimate unavailable.');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('backfills the previous window when old code already advanced state without recording a notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-22T00:00:00.000Z',
      resetAfterAt: '2026-06-29T00:00:00.000Z',
      usedPercent: 18,
    });

    const currentUpstream = upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 42);
    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-23T00:05:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 4, tokens: { input: 200 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return snapshot;
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();
    await notifier.pollOnce();

    expect(exportCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:00:00.000Z</code> -> <code>2026-06-22T00:00:00.000Z</code>');
    expect(messages[0]!.text).toContain('<b>Your upstream tokens</b>: <b>200</b>');
    expect(messages[0]!.text).toContain('Secondary quota estimate unavailable.');
    expect(messages[0]!.text).not.toContain('<b>18.0%</b>');
    expect(messages[0]!.text).not.toContain('<b>42.0%</b>');
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-15T00:00:00.000Z', '2026-06-22T00:00:00.000Z')).not.toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(42);
  });

  it('backfills the previous window when old code advanced state and Floway quota is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-22T00:00:00.000Z',
      resetAfterAt: '2026-06-29T00:00:00.000Z',
      usedPercent: 18,
    });

    const currentUpstream = { ...upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 18), codex_quota: null };
    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-23T00:05:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 4, tokens: { input: 200 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return snapshot;
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();
    await notifier.pollOnce();

    expect(exportCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:00:00.000Z</code> -> <code>2026-06-22T00:00:00.000Z</code>');
    expect(messages[0]!.text).toContain('<b>Your upstream tokens</b>: <b>200</b>');
    expect(messages[0]!.text).toContain('Secondary quota estimate unavailable.');
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-15T00:00:00.000Z', '2026-06-22T00:00:00.000Z')).not.toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(18);
  });

  it('refreshes current window state after a backfill notification was already recorded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-22T00:00:00.000Z',
      resetAfterAt: '2026-06-29T00:00:00.000Z',
      usedPercent: 18,
    });
    store.upsertSecondaryWindowNotification({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-15T00:00:00.000Z',
      resetAfterAt: '2026-06-22T00:00:00.000Z',
    });

    const messages: Array<{ chatId: string; text: string }> = [];
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 42)],
      listUsers: async () => {
        throw new Error('users should not be listed without notification candidates');
      },
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        throw new Error('usage export should not be called for an already-sent notification');
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toEqual([]);
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(42);
  });

  it('does not notify when Floway reports a future secondary window before it starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-28T10:25:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-28T00:51:17.124Z',
      resetAfterAt: '2026-07-05T00:51:17.124Z',
      usedPercent: 3,
    });
    store.upsertSecondaryWindowNotification({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-21T00:51:16.847Z',
      resetAfterAt: '2026-06-28T00:51:16.847Z',
    });

    const messages: Array<{ chatId: string; text: string }> = [];
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-07-12T00:51:16.847Z', 4)],
      listUsers: async () => {
        throw new Error('users should not be listed without notification candidates');
      },
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        throw new Error('usage export should not be called for a future window');
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toEqual([]);
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-28T00:51:16.847Z', '2026-07-05T00:51:16.847Z')).toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-07-05T00:51:17.124Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(3);
  });

  it('does not treat same-window reset timestamp drift as a refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-28T10:25:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-28T00:51:17.124Z',
      resetAfterAt: '2026-07-05T00:51:17.124Z',
      usedPercent: 3,
    });
    store.upsertSecondaryWindowNotification({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-21T00:51:16.847Z',
      resetAfterAt: '2026-06-28T00:51:16.847Z',
    });

    const messages: Array<{ chatId: string; text: string }> = [];
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-07-05T00:51:18.025Z', 3)],
      listUsers: async () => {
        throw new Error('users should not be listed without notification candidates');
      },
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        throw new Error('usage export should not be called for timestamp drift');
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toEqual([]);
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-28T00:51:18.025Z', '2026-07-05T00:51:18.025Z')).toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-07-05T00:51:18.025Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(3);
  });

  it('reports a manually refreshed overlapping window using the new window start as the previous end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-06-30T10:25:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-28T00:51:18.169Z',
      resetAfterAt: '2026-07-05T00:51:18.169Z',
      usedPercent: 5,
    });
    store.upsertSecondaryWindowNotification({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-21T00:51:18.025Z',
      resetAfterAt: '2026-06-28T00:51:18.025Z',
    });

    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-30T10:25:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-28T12', requests: 1, tokens: { input: 100 }, cost: { input: 1 } },
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-29T12', requests: 1, tokens: { input: 999 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-07-06T11:01:31.799Z', 6)],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => snapshot,
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-28T00:51:18.169Z</code> -> <code>2026-06-29T11:01:31.799Z</code>');
    expect(messages[0]!.text).toContain('<b>Window note</b>: Upstream refreshed this secondary window early; this is not a natural cycle.');
    expect(messages[0]!.text).toContain('<b>Your upstream tokens</b>: <b>100</b>');
    expect(messages[0]!.text).not.toContain('999');
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-22T11:01:31.799Z', '2026-06-29T11:01:31.799Z')).toBeNull();
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-28T00:51:18.169Z', '2026-06-29T11:01:31.799Z')).not.toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.windowStartAt).toBe('2026-06-29T11:01:31.799Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-07-06T11:01:31.799Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(6);

    await notifier.pollOnce();

    expect(messages).toHaveLength(1);
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-22T11:01:31.799Z', '2026-06-29T11:01:31.799Z')).toBeNull();
  });

  it('treats a current window that starts in the previous end hour as a natural refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    vi.setSystemTime(new Date('2026-07-05T00:10:00.000Z'));
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-28T00:51:18.169Z',
      resetAfterAt: '2026-07-05T00:51:18.169Z',
      usedPercent: 5,
    });
    store.upsertSecondaryWindowNotification({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-21T00:51:18.025Z',
      resetAfterAt: '2026-06-28T00:51:18.025Z',
    });

    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-07-05T00:10:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-07-04T12', requests: 1, tokens: { input: 100 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-07-12T00:30:00.000Z', 6)],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => snapshot,
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-28T00:51:18.169Z</code> -> <code>2026-07-05T00:51:18.169Z</code>');
    expect(messages[0]!.text).not.toContain('<b>Window note</b>');
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-28T00:30:00.000Z', '2026-07-05T00:30:00.000Z')).toBeNull();
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-28T00:51:18.169Z', '2026-07-05T00:51:18.169Z')).not.toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.windowStartAt).toBe('2026-07-05T00:30:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-07-12T00:30:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.usedPercent).toBe(6);
  });

  it('does not let a premature notification ledger suppress the real reset notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-28T00:51:17.124Z',
      resetAfterAt: '2026-07-05T00:51:17.124Z',
      usedPercent: 3,
    });
    vi.setSystemTime(new Date('2026-06-28T10:25:00.000Z'));
    store.upsertSecondaryWindowNotification({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-28T00:51:16.847Z',
      resetAfterAt: '2026-07-05T00:51:16.847Z',
    });
    vi.setSystemTime(new Date('2026-07-05T00:52:00.000Z'));

    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-07-05T00:52:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-07-04T12', requests: 1, tokens: { input: 100 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-07-12T00:51:16.847Z', 4)],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => snapshot,
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-28T00:51:17.124Z</code> -> <code>2026-07-05T00:51:17.124Z</code>');
    expect(messages[0]!.text).toContain('<b>Your upstream tokens</b>: <b>100</b>');
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-28T00:51:17.124Z', '2026-07-05T00:51:17.124Z')?.sentAt)
      .toBe('2026-07-05T00:52:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-07-12T00:51:16.847Z');
  });

  it('does not backfill a previous window that ended before the binding existed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-22T00:00:00.000Z',
      resetAfterAt: '2026-06-29T00:00:00.000Z',
      usedPercent: 18,
    });

    const messages: Array<{ chatId: string; text: string }> = [];
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 18)],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-23T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        throw new Error('usage export should not be called without notification candidates');
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(messages).toEqual([]);
    expect(store.getSecondaryWindowNotification('12345', 'up_a', '2026-06-15T00:00:00.000Z', '2026-06-22T00:00:00.000Z')).toBeNull();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('uses local state to notify when Floway quota is stale after the reset time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });

    let currentUpstream = upstreamWithSecondaryReset('2026-06-22T00:00:00.000Z', 80);
    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-22T00:05:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 2, tokens: { input: 100 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return snapshot;
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-22T00:00:00.000Z');

    currentUpstream = { ...currentUpstream, codex_quota: null };
    await notifier.pollOnce();
    expect(messages).toHaveLength(0);
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-22T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-06-22T00:01:00.000Z'));
    await notifier.pollOnce();
    await notifier.pollOnce();

    expect(exportCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:00:00.000Z</code> -> <code>2026-06-22T00:00:00.000Z</code>');
    expect(messages[0]!.text).toContain('<b>Upstream secondary used</b>:\n[||||||||||||   ] <b>80.0%</b>');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('uses the reset hour when local state detects stale Floway quota', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });

    let currentUpstream = upstreamWithSecondaryReset('2026-06-22T00:51:00.000Z', 80);
    const messages: Array<{ chatId: string; text: string }> = [];
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-22T00:10:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
      usage: [
        { keyId: 'key_a', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-21T12', requests: 2, tokens: { input: 100 }, cost: { input: 1 } },
      ],
    };
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => snapshot,
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    currentUpstream = { ...currentUpstream, codex_quota: null };
    vi.setSystemTime(new Date('2026-06-22T00:10:00.000Z'));
    await notifier.pollOnce();

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('<b>Previous window</b>: <code>2026-06-15T00:51:00.000Z</code> -> <code>2026-06-22T00:51:00.000Z</code>');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.windowStartAt).toBe('2026-06-22T00:51:00.000Z');
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:51:00.000Z');
  });

  it('clears stale secondary window state when an upstream no longer supports Codex windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:01:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_a',
      windowStartAt: '2026-06-15T00:00:00.000Z',
      resetAfterAt: '2026-06-22T00:00:00.000Z',
      usedPercent: 80,
    });

    let exportCalls = 0;
    const messages: Array<{ chatId: string; text: string }> = [];
    const unsupportedUpstream = {
      ...upstreamWithSecondaryReset('2026-06-22T00:00:00.000Z', 80),
      provider: 'custom',
      codex_quota: null,
    };
    const floway = {
      listUpstreams: async () => [unsupportedUpstream],
      listUsers: async () => [],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return emptySnapshot();
      },
    };
    const bot = {
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          messages.push({ chatId, text });
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(exportCalls).toBe(0);
    expect(messages).toHaveLength(0);
    expect(store.getSecondaryWindowState('12345', 'up_a')).toBeNull();
  });

  it('does not notify for upstreams outside the bound user access list', async () => {
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });
    store.upsertSecondaryWindowState({
      telegramUserId: '12345',
      upstreamId: 'up_b',
      windowStartAt: '2026-06-15T00:00:00.000Z',
      resetAfterAt: '2026-06-22T00:00:00.000Z',
      usedPercent: 80,
    });

    let exportCalls = 0;
    const floway = {
      listUpstreams: async () => [upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 0.4, 'up_b')],
      listUsers: async () => [],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => {
        exportCalls += 1;
        return emptySnapshot();
      },
    };
    const bot = {
      telegram: {
        sendMessage: async () => ({}),
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();

    expect(exportCalls).toBe(0);
    expect(store.getSecondaryWindowState('12345', 'up_b')).toBeNull();
  });

  it('retries notifications after Telegram send failures before advancing state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'));
    const store = createStore();
    store.upsert({
      telegramUserId: '12345',
      flowayUserId: 7,
      username: 'alice',
      flowaySession: 'session-alice',
    });

    let currentUpstream = upstreamWithSecondaryReset('2026-06-22T00:00:00.000Z', 80);
    let sendAttempts = 0;
    const floway = {
      listUpstreams: async () => [currentUpstream],
      listUsers: async () => [
        { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'], createdAt: '2026-06-15T00:00:00.000Z' },
      ],
      getMe: async () => ({
        user: { id: 7, username: 'alice', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: ['up_a'] },
        viaApiKey: false,
        apiKey: null,
      }),
      exportUsageSnapshot: async () => emptySnapshot(),
    };
    const bot = {
      telegram: {
        sendMessage: async () => {
          sendAttempts += 1;
          if (sendAttempts === 1) throw new Error('telegram failed');
          return {};
        },
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    await notifier.pollOnce();
    vi.setSystemTime(new Date('2026-06-22T00:01:00.000Z'));
    currentUpstream = upstreamWithSecondaryReset('2026-06-29T00:00:00.000Z', 0.4);
    await notifier.pollOnce();

    expect(sendAttempts).toBe(1);
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-22T00:00:00.000Z');

    await notifier.pollOnce();

    expect(sendAttempts).toBe(2);
    expect(store.getSecondaryWindowState('12345', 'up_a')?.resetAfterAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('waits for the active poll before stop resolves', async () => {
    const store = createStore();
    let resolveUpstreams!: (upstreams: UpstreamRecord[]) => void;
    const upstreams = new Promise<UpstreamRecord[]>(resolve => {
      resolveUpstreams = resolve;
    });
    let listStarted = false;
    const floway = {
      listUpstreams: async () => {
        listStarted = true;
        return upstreams;
      },
      listUsers: async () => [],
      getMe: async () => {
        throw new Error('binding refresh should not run without bindings');
      },
      exportUsageSnapshot: async () => emptySnapshot(),
    };
    const bot = {
      telegram: {
        sendMessage: async () => ({}),
      },
    };
    const notifier = new SecondaryWindowNotifier({ store, floway, bot, intervalSeconds: 60 });

    notifier.start();
    expect(listStarted).toBe(true);

    const stopPromise = notifier.stop();
    const earlyResult = await Promise.race([
      stopPromise.then(() => 'stopped' as const),
      Promise.resolve('pending' as const),
    ]);
    expect(earlyResult).toBe('pending');

    resolveUpstreams([]);
    await stopPromise;
  });
});

const createStore = (): BindingStore => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-tg-bot-'));
  tempDirs.push(dir);
  const store = new BindingStore(join(dir, 'bot.sqlite'), randomBytes(32));
  stores.push(store);
  return store;
};

const emptySnapshot = (): SanitizedExportSnapshot => ({
  exportedAt: '2026-06-22T00:05:00.000Z',
  users: [{ id: 7, username: 'alice', deletedAt: null }],
  apiKeys: [{ id: 'key_a', userId: 7, name: 'Alice key', createdAt: '2026-06-15T00:00:00.000Z', upstreamIds: null, deletedAt: null }],
  usage: [],
});

const upstreamWithSecondaryReset = (resetAfterAt: string, usedPercent: number, id = 'up_a'): UpstreamRecord => ({
  id,
  provider: 'codex',
  name: 'Codex main',
  enabled: true,
  sort_order: 1,
  created_at: '2026-06-15T00:00:00.000Z',
  updated_at: '2026-06-15T00:00:00.000Z',
  flag_overrides: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  config: {},
  state: null,
  codex_quota: {
    observed_at: resetAfterAt,
    secondary_window_minutes: 10080,
    secondary_reset_after_at: resetAfterAt,
    secondary_used_percent: usedPercent,
  },
});
