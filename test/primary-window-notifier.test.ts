import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BindingStore,
  type NewPrimaryWindowEvent,
  type PrimaryWindowFacts,
} from '../src/db.js';
import { PrimaryWindowNotifier } from '../src/primary-window-notifier.js';
import type {
  AuthMeResponse,
  FlowayAdminUser,
  SanitizedExportSnapshot,
  UpstreamRecord,
} from '../src/types.js';

const tempDirs: string[] = [];
const stores: BindingStore[] = [];

const USER: AuthMeResponse = {
  user: { id: 7, username: 'alice', isAdmin: false, upstreamIds: ['up_a'] },
  viaApiKey: false,
  apiKey: null,
};

const ADMIN_USERS: FlowayAdminUser[] = [
  { id: 7, username: 'alice', isAdmin: false, upstreamIds: ['up_a'], createdAt: '2026-06-01T00:00:00.000Z' },
];

const EMPTY_SNAPSHOT: SanitizedExportSnapshot = {
  exportedAt: '2026-06-01T05:05:00.000Z',
  users: [{ id: 7, username: 'alice', deletedAt: null }],
  apiKeys: [{
    id: 'key_a',
    userId: 7,
    name: 'Alice key',
    createdAt: '2026-06-01T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 0,
  }],
  usage: [],
};

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PrimaryWindowNotifier', () => {
  it('silently seeds the first provider observation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T04:55:00.000Z');
    const store = createStore();
    bindAlice(store);
    const upstream = quotaUpstream('2026-06-01T00:00:00.000Z', '2026-06-01T05:00:00.000Z', '2026-06-01T04:50:00.000Z', 80);
    const runtime = createRuntime(store, () => [upstream]);

    await runtime.notifier.pollOnce();

    expect(store.getCursor('up_a')).toMatchObject({
      revision: 0,
      anchor: { startAtMs: Date.parse('2026-06-01T00:00:00.000Z'), endAtMs: Date.parse('2026-06-01T05:00:00.000Z') },
      pending: null,
    });
    expect(store.listEvents()).toEqual([]);
    expect(store.listDeliveries()).toEqual([]);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('requires two provider observations before committing and delivering a natural refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T04:55:00.000Z');
    const store = createStore();
    bindAlice(store);
    let upstream = quotaUpstream('2026-06-01T00:00:00.000Z', '2026-06-01T05:00:00.000Z', '2026-06-01T04:50:00.000Z', 80);
    const runtime = createRuntime(store, () => [upstream]);
    await runtime.notifier.pollOnce();

    vi.setSystemTime('2026-06-01T05:02:00.000Z');
    upstream = quotaUpstream('2026-06-01T05:00:00.000Z', '2026-06-01T10:00:00.000Z', '2026-06-01T05:01:00.000Z', 2);
    await runtime.notifier.pollOnce();
    expect(store.getCursor('up_a')).toMatchObject({ revision: 0, pending: { kind: 'natural', observationCount: 1 } });
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    vi.setSystemTime('2026-06-01T05:03:00.000Z');
    await runtime.notifier.pollOnce();

    expect(store.getCursor('up_a')).toMatchObject({ revision: 1, pending: null });
    expect(store.listEvents()).toEqual([expect.objectContaining({ kind: 'natural' })]);
    expect(store.listDeliveries()).toEqual([expect.objectContaining({ status: 'sent', attempts: 1 })]);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[1]).toContain('Provider-confirmed natural refresh');
  });

  it('does not confirm a provider window before its exact start in the same hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T04:55:00.000Z');
    const store = createStore();
    bindAlice(store);
    let upstream = quotaUpstream('2026-06-01T00:30:00.000Z', '2026-06-01T05:30:00.000Z', '2026-06-01T04:50:00.000Z', 80);
    const runtime = createRuntime(store, () => [upstream]);
    await runtime.notifier.pollOnce();

    upstream = quotaUpstream('2026-06-01T05:30:00.000Z', '2026-06-01T10:30:00.000Z', '2026-06-01T05:05:00.000Z', 1);
    vi.setSystemTime('2026-06-01T05:10:00.000Z');
    await runtime.notifier.pollOnce();
    await runtime.notifier.pollOnce();
    expect(store.getCursor('up_a')).toMatchObject({ revision: 0, pending: { observationCount: 1 } });
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    vi.setSystemTime('2026-06-01T05:31:00.000Z');
    await runtime.notifier.pollOnce();
    expect(store.getCursor('up_a')?.revision).toBe(1);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the canonical anchor stable across tolerated timestamp drift', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-08T00:00:00.000Z');
    const store = createStore();
    bindAlice(store);
    let upstream = quotaUpstream('2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z', '2026-06-07T23:00:00.000Z', 60);
    const runtime = createRuntime(store, () => [upstream]);
    await runtime.notifier.pollOnce();
    const originalAnchor = store.getCursor('up_a')?.anchor;

    upstream = quotaUpstream('2026-06-01T04:00:00.000Z', '2026-06-08T04:00:00.000Z', '2026-06-08T00:01:00.000Z', 62);
    await runtime.notifier.pollOnce();
    expect(store.getCursor('up_a')?.anchor).toEqual(originalAnchor);

    upstream = quotaUpstream('2026-06-01T08:00:00.000Z', '2026-06-08T08:00:00.000Z', '2026-06-08T00:02:00.000Z', 63);
    await runtime.notifier.pollOnce();
    expect(store.getCursor('up_a')?.anchor).toEqual(originalAnchor);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('detects an early manual refresh for a five-hour window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T02:50:00.000Z');
    const store = createStore();
    bindAlice(store);
    let upstream = quotaUpstream('2026-06-01T00:00:00.000Z', '2026-06-01T05:00:00.000Z', '2026-06-01T02:45:00.000Z', 70);
    const runtime = createRuntime(store, () => [upstream]);
    await runtime.notifier.pollOnce();

    upstream = quotaUpstream('2026-06-01T03:00:00.000Z', '2026-06-01T08:00:00.000Z', '2026-06-01T03:01:00.000Z', 4);
    vi.setSystemTime('2026-06-01T03:02:00.000Z');
    await runtime.notifier.pollOnce();
    await runtime.notifier.pollOnce();

    expect(store.listEvents()).toEqual([expect.objectContaining({
      kind: 'manual',
      effectivePreviousUsageEndAtMs: Date.parse('2026-06-01T03:00:00.000Z'),
    })]);
    expect(runtime.sendMessage.mock.calls[0]?.[1]).toContain('Early/manual provider refresh');
  });

  it('preserves the cursor and never fabricates resets while quota is missing or malformed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T04:55:00.000Z');
    const store = createStore();
    bindAlice(store);
    let upstream = quotaUpstream('2026-06-01T00:00:00.000Z', '2026-06-01T05:00:00.000Z', '2026-06-01T04:50:00.000Z', 80);
    const runtime = createRuntime(store, () => [upstream]);
    await runtime.notifier.pollOnce();
    const anchor = store.getCursor('up_a')?.anchor;

    vi.setSystemTime('2026-06-02T05:00:00.000Z');
    upstream = { ...upstream, codex_quota: null };
    await runtime.notifier.pollOnce();
    upstream = { ...upstream, codex_quota: { premium: { observed_at: 'bad', active_limit: 'premium' } } };
    await runtime.notifier.pollOnce();

    expect(store.getCursor('up_a')?.anchor).toEqual(anchor);
    expect(store.listEvents()).toEqual([]);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('advances the cursor before Telegram delivery and retries a failed send after restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T04:55:00.000Z');
    const { dbPath, secretKey, store } = createFileStore();
    bindAlice(store);
    let upstream = quotaUpstream('2026-06-01T00:00:00.000Z', '2026-06-01T05:00:00.000Z', '2026-06-01T04:50:00.000Z', 80);
    const failing = createRuntime(store, () => [upstream]);
    failing.sendMessage.mockRejectedValueOnce(new Error('temporary Telegram failure'));
    await failing.notifier.pollOnce();

    upstream = quotaUpstream('2026-06-01T05:00:00.000Z', '2026-06-01T10:00:00.000Z', '2026-06-01T05:01:00.000Z', 1);
    vi.setSystemTime('2026-06-01T05:02:00.000Z');
    await failing.notifier.pollOnce();
    vi.setSystemTime('2026-06-01T05:03:00.000Z');
    await failing.notifier.pollOnce();

    expect(store.getCursor('up_a')?.revision).toBe(1);
    expect(store.listDeliveries()).toEqual([expect.objectContaining({ status: 'pending', attempts: 1 })]);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    vi.setSystemTime('2026-06-01T05:03:31.000Z');
    const reopened = track(new BindingStore(dbPath, secretKey));
    const restarted = createRuntime(reopened, () => [upstream]);
    await restarted.notifier.pollOnce();

    expect(reopened.listEvents()).toHaveLength(1);
    expect(reopened.listDeliveries()).toEqual([expect.objectContaining({ status: 'sent', attempts: 2 })]);
    expect(restarted.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('allows only one of two notifier instances to claim a pending delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T05:03:00.000Z');
    const { dbPath, secretKey, store: firstStore } = createFileStore();
    const binding = bindAlice(firstStore);
    seedPendingDelivery(firstStore, binding.bindingId);
    const secondStore = track(new BindingStore(dbPath, secretKey));
    const upstream = quotaUpstream('2026-06-01T05:00:00.000Z', '2026-06-01T10:00:00.000Z', '2026-06-01T05:01:00.000Z', 1);
    const sendMessage = vi.fn(async () => undefined);
    const first = createRuntime(firstStore, () => [upstream], sendMessage);
    const second = createRuntime(secondStore, () => [upstream], sendMessage);

    await Promise.all([first.notifier.pollOnce(), second.notifier.pollOnce()]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstStore.listDeliveries()).toEqual([expect.objectContaining({ status: 'sent' })]);
  });

  it('sends the reset alert with an unavailable section when enrichment fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-06-01T05:03:00.000Z');
    const store = createStore();
    const binding = bindAlice(store);
    seedPendingDelivery(store, binding.bindingId);
    const upstream = quotaUpstream('2026-06-01T05:00:00.000Z', '2026-06-01T10:00:00.000Z', '2026-06-01T05:01:00.000Z', 1);
    const runtime = createRuntime(store, () => [upstream]);
    runtime.exportUsageSnapshot.mockRejectedValue(new Error('bad export'));

    await runtime.notifier.pollOnce();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const text = runtime.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain('Primary window refreshed');
    expect(text).toContain('attribution are unavailable');
    expect(text.length).toBeLessThanOrEqual(3_800);
  });

  it('waits for an active observation poll before stopping', async () => {
    const store = createStore();
    let resolveUpstreams!: (upstreams: UpstreamRecord[]) => void;
    const upstreamPromise = new Promise<UpstreamRecord[]>(resolve => {
      resolveUpstreams = resolve;
    });
    const runtime = createRuntime(store, () => upstreamPromise);

    const poll = runtime.notifier.pollOnce();
    const stop = runtime.notifier.stop();
    expect(await Promise.race([stop.then(() => 'stopped'), Promise.resolve('pending')])).toBe('pending');

    resolveUpstreams([]);
    await poll;
    await stop;
  });
});

const createRuntime = (
  store: BindingStore,
  upstreams: () => UpstreamRecord[] | Promise<UpstreamRecord[]>,
  sendMessage = vi.fn(async () => undefined),
) => {
  const exportUsageSnapshot = vi.fn(async () => EMPTY_SNAPSHOT);
  const floway = {
    listUpstreams: vi.fn(async () => await upstreams()),
    listUsers: vi.fn(async () => ADMIN_USERS),
    getMe: vi.fn(async () => USER),
    exportUsageSnapshot,
  };
  return {
    notifier: new PrimaryWindowNotifier({ store, floway, bot: { telegram: { sendMessage } }, intervalSeconds: 300 }),
    floway,
    sendMessage,
    exportUsageSnapshot,
  };
};

const quotaUpstream = (
  startAt: string,
  endAt: string,
  observedAt: string,
  usedPercent: number,
): UpstreamRecord => ({
  id: 'up_a',
  kind: 'codex',
  name: 'Codex main',
  enabled: true,
  sort_order: 1,
  created_at: '2026-05-01T00:00:00.000Z',
  updated_at: observedAt,
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  color: null,
  config: {},
  state: null,
  codex_quota: {
    premium: {
      observed_at: observedAt,
      active_limit: 'premium',
      primary_window_minutes: (Date.parse(endAt) - Date.parse(startAt)) / 60_000,
      primary_reset_after_at: endAt,
      primary_used_percent: usedPercent,
    },
  },
});

const bindAlice = (store: BindingStore) => store.replaceBinding({
  telegramUserId: '100',
  flowayUserId: 7,
  username: 'alice',
  flowaySession: 'session',
}, Date.parse('2026-05-01T00:00:00.000Z'));

const createStore = (): BindingStore => createFileStore().store;

const createFileStore = (): { dbPath: string; secretKey: Buffer; store: BindingStore } => {
  const dir = mkdtempSync(join(tmpdir(), 'floway-notifier-test-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'bot.sqlite');
  const secretKey = randomBytes(32);
  return { dbPath, secretKey, store: track(new BindingStore(dbPath, secretKey)) };
};

const track = (store: BindingStore): BindingStore => {
  stores.push(store);
  return store;
};

const seedPendingDelivery = (store: BindingStore, bindingId: number): void => {
  const previous = facts('2026-06-01T00:00:00.000Z', '2026-06-01T05:00:00.000Z', '2026-06-01T04:50:00.000Z', 80);
  const current = facts('2026-06-01T05:00:00.000Z', '2026-06-01T10:00:00.000Z', '2026-06-01T05:01:00.000Z', 1);
  store.seedCursor('up_a', previous);
  store.stagePendingCandidate('up_a', 0, {
    kind: 'natural',
    startAtMs: current.startAtMs,
    endAtMs: current.endAtMs,
    durationMs: current.durationMs,
    observedAtMs: current.observedAtMs,
    firstSeenAtMs: Date.parse('2026-06-01T05:02:00.000Z'),
  });
  const event: NewPrimaryWindowEvent = {
    upstreamId: 'up_a',
    fromRevision: 0,
    toRevision: 1,
    upstreamKind: 'codex',
    upstreamName: 'Codex main',
    kind: 'natural',
    previous,
    current,
    detectedAtMs: Date.parse('2026-06-01T05:03:00.000Z'),
    effectivePreviousUsageEndAtMs: null,
  };
  expect(store.commitTransition(0, event, [bindingId], Date.parse('2026-06-01T05:02:00.000Z')).status).toBe('committed');
};

const facts = (startAt: string, endAt: string, observedAt: string, usedPercent: number): PrimaryWindowFacts => ({
  startAtMs: Date.parse(startAt),
  endAtMs: Date.parse(endAt),
  durationMs: Date.parse(endAt) - Date.parse(startAt),
  observedAtMs: Date.parse(observedAt),
  usedPercent,
  quotaBucketKey: 'premium',
  activeLimit: 'premium',
});
