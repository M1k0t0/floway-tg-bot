import { describe, expect, it } from 'vitest';

import {
  addUsageRecord,
  emptyTotals,
  quotaObservationToUsageWindow,
  recordCostUsd,
  scopeUsageSnapshotForUser,
  summarizeUsageLeaderboard,
  summarizeUsageQuotaEstimate,
  summarizeUsageWindow,
  tokenTotal,
} from '../src/usage.js';
import type {
  BillingMetric,
  SanitizedExportApiKey,
  GlobalUsageSnapshot,
  UsageMetricRecord,
  UsageRecord,
} from '../src/types.js';

const metric = (
  name: BillingMetric,
  quantity: string,
  unitPrice: string | null = null,
): UsageMetricRecord => ({ metric: name, quantity, unitPrice });

const usageRecord = (
  keyId: string,
  upstream: string | null,
  hour: string,
  requests: number,
  metrics: UsageMetricRecord[],
  pricingSelector: UsageRecord['pricingSelector'] = {},
): UsageRecord => ({
  keyId,
  model: 'm',
  upstream,
  modelKey: 'm',
  hour,
  pricingSelector,
  requests,
  metrics,
});

const exportKey = (
  id: string,
  userId: number,
  upstreamIds: readonly string[] | null = null,
): SanitizedExportApiKey => ({
  id,
  userId,
  name: id,
  createdAt: '2026-06-01T00:00:00.000Z',
  upstreamIds,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
});

describe('usage windows', () => {
  it('derives exact Floway hour buckets from a resolved quota observation', () => {
    const window = quotaObservationToUsageWindow({
      upstreamId: 'up',
      bucketKey: 'chatgpt-plus',
      activeLimit: 'premium',
      observedAt: '2026-06-21T00:31:00.000Z',
      observedAtMs: Date.parse('2026-06-21T00:31:00.000Z'),
      startAt: '2026-06-21T00:30:45.123Z',
      startMs: Date.parse('2026-06-21T00:30:45.123Z'),
      endAt: '2026-06-28T00:30:45.123Z',
      endMs: Date.parse('2026-06-28T00:30:45.123Z'),
      durationMs: 10_080 * 60_000,
      usedPercent: 90,
    });

    expect(window).toEqual({
      label: 'Quota window',
      startAt: '2026-06-21T00:30:45.123Z',
      endAt: '2026-06-28T00:30:45.123Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-28T00',
      observedAt: '2026-06-21T00:31:00.000Z',
      observedAtMs: Date.parse('2026-06-21T00:31:00.000Z'),
      startMs: Date.parse('2026-06-21T00:30:45.123Z'),
      endMs: Date.parse('2026-06-28T00:30:45.123Z'),
      durationMs: 10_080 * 60_000,
      upstreamPercent: 90,
      quotaBucketKey: 'chatgpt-plus',
      quotaActiveLimit: 'premium',
    });
  });

  it('omits upstream percentage when the provider did not report it', () => {
    const window = quotaObservationToUsageWindow({
      upstreamId: 'up',
      bucketKey: 'premium',
      activeLimit: 'premium',
      observedAt: '2026-06-21T00:00:00.000Z',
      observedAtMs: Date.parse('2026-06-21T00:00:00.000Z'),
      startAt: '2026-06-21T00:00:00.000Z',
      startMs: Date.parse('2026-06-21T00:00:00.000Z'),
      endAt: '2026-06-21T05:00:00.000Z',
      endMs: Date.parse('2026-06-21T05:00:00.000Z'),
      durationMs: 300 * 60_000,
      usedPercent: null,
    });

    expect(window).not.toHaveProperty('upstreamPercent');
  });
});

describe('usage metrics', () => {
  it('computes cost from decimal quantities and per-base-unit prices', () => {
    const record = usageRecord('k1', 'up', '2026-06-21T00', 1, [
      metric('input_tokens', '1000000', '0.000002'),
      metric('input_cache_read_tokens', '1000000', '0.0000005'),
      metric('output_tokens', '2000000', '0.00001'),
    ]);

    expect(recordCostUsd(record)).toBe(22.5);
  });

  it('charges non-token metrics but excludes them from token totals', () => {
    const record = usageRecord('k1', 'up', '2026-06-21T00', 1, [
      metric('input_audio_tokens', '12.5', '0.01'),
      metric('input_audio_seconds', '2.5', '0.1'),
      metric('rerank_searches', '3', '0.05'),
      metric('output_tokens', '100', null),
    ]);
    const totals = emptyTotals();
    addUsageRecord(totals, record);

    expect(totals.tokens).toEqual({ input_audio: 12.5, output: 100 });
    expect(tokenTotal(totals.tokens)).toBe(112.5);
    expect(totals.cost).toBeCloseTo(0.525);
  });

  it('rejects invalid decimal quantities instead of corrupting reports', () => {
    const record = usageRecord('k1', 'up', '2026-06-21T00', 1, [
      metric('input_tokens', 'not-a-number', '0.1'),
    ]);

    expect(() => recordCostUsd(record)).toThrow('input_tokens quantity');
  });
});

describe('usage summary', () => {
  it('uses raw export metrics for selected-upstream shares and cost', () => {
    const snapshot: GlobalUsageSnapshot = {
      exportedAt: '2026-06-21T00:00:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [exportKey('k1', 7), exportKey('k2', 8)],
      usage: [
        usageRecord('k1', 'up1', '2026-06-21T01', 2, [metric('input_tokens', '100', '0.000001')]),
        usageRecord('k2', 'up1', '2026-06-21T01', 6, [metric('input_tokens', '300', '0.000001')]),
        usageRecord('k1', 'up2', '2026-06-21T01', 100, [metric('input_tokens', '999', '0.000001')]),
        usageRecord('k1', 'up1', '2026-06-21T05', 100, [metric('input_tokens', '999', '0.000001')]),
      ],
    };

    const report = summarizeUsageWindow(7, 'up1', {
      label: 'Quota window',
      startAt: '2026-06-21T00:00:00.000Z',
      endAt: '2026-06-21T05:00:00.000Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-21T05',
    }, snapshot);

    expect(report.user.requests).toBe(2);
    expect(report.upstream.requests).toBe(8);
    expect(report.userTokenSharePercent).toBe(25);
    expect(report.userRequestSharePercent).toBe(25);
    expect(report.user.cost).toBe(0.0001);
  });

  it('handles zero upstream totals without percentages', () => {
    const report = summarizeUsageWindow(1, 'up', {
      label: 'Quota window',
      startAt: '2026-06-21T00:00:00.000Z',
      endAt: '2026-06-21T01:00:00.000Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-21T01',
    }, { exportedAt: 'x', users: [], apiKeys: [], usage: [] });
    expect(report.userTokenSharePercent).toBeNull();
    expect(report.userRequestSharePercent).toBeNull();
  });
});

describe('user usage scope', () => {
  const snapshot = (): GlobalUsageSnapshot => ({
    exportedAt: '2026-06-22T12:34:00.000Z',
    users: [
      { id: 1, username: 'alice', deletedAt: null },
      { id: 2, username: 'bob', deletedAt: null },
      { id: 3, username: 'carol', deletedAt: null },
      { id: 4, username: 'unused', deletedAt: null },
    ],
    apiKeys: [
      exportKey('k1', 1, ['up_b']),
      exportKey('k2', 2),
      exportKey('k3', 3),
      exportKey('unused', 4),
    ],
    usage: [
      usageRecord('k1', 'up_a', '2026-06-22T12', 1, [metric('input_tokens', '10')], {
        threshold: { operator: 'gte', value: 100 },
      }),
      usageRecord('k2', 'up_b', '2026-06-22T12', 2, [metric('output_tokens', '20')]),
      usageRecord('k3', null, '2026-06-22T12', 3, [metric('input_cache_read_tokens', '30')]),
      usageRecord('orphan', 'up_a', '2026-06-22T12', 4, [metric('input_tokens', '40')]),
    ],
  });

  it('derives independent snapshots from the requesting user upstream access', () => {
    const globalSnapshot = snapshot();
    const original = JSON.parse(JSON.stringify(globalSnapshot)) as GlobalUsageSnapshot;

    const upA = scopeUsageSnapshotForUser(globalSnapshot, { upstreamIds: ['up_a', 'up_a', 'unknown'] });
    const upB = scopeUsageSnapshotForUser(globalSnapshot, { upstreamIds: ['up_b'] });

    expect(upA.usage.map(record => record.keyId)).toEqual(['k1', 'orphan']);
    expect(upA.apiKeys).toEqual([{ id: 'k1', userId: 1 }]);
    expect(upA.users).toEqual([{ id: 1, username: 'alice' }]);
    expect(upB.usage.map(record => record.keyId)).toEqual(['k2']);
    expect(upB.users).toEqual([{ id: 2, username: 'bob' }]);
    expect(globalSnapshot).toEqual(original);
    expect(upA).not.toBe(globalSnapshot);
    expect(upA.usage).not.toBe(globalSnapshot.usage);
    expect(upA.usage[0]).not.toBe(globalSnapshot.usage[0]);
    expect(upA.usage[0]?.metrics).not.toBe(globalSnapshot.usage[0]?.metrics);
    expect(upA.usage[0]?.metrics[0]).not.toBe(globalSnapshot.usage[0]?.metrics[0]);
    expect(upA.usage[0]?.pricingSelector).not.toBe(globalSnapshot.usage[0]?.pricingSelector);
    expect(upA.usage[0]?.pricingSelector.threshold).not.toBe(globalSnapshot.usage[0]?.pricingSelector.threshold);
  });

  it('distinguishes unrestricted, empty, and multi-upstream access', () => {
    const globalSnapshot = snapshot();
    const unrestricted = scopeUsageSnapshotForUser(globalSnapshot, { upstreamIds: null });
    const empty = scopeUsageSnapshotForUser(globalSnapshot, { upstreamIds: [] });
    const multiple = scopeUsageSnapshotForUser(globalSnapshot, { upstreamIds: ['up_a', 'up_b'] });

    expect(unrestricted).not.toBe(globalSnapshot);
    expect(unrestricted.usage.map(record => record.upstream)).toEqual(['up_a', 'up_b', null, 'up_a']);
    expect(unrestricted.users.map(user => user.username)).toEqual(['alice', 'bob', 'carol']);
    expect(empty).toMatchObject({ users: [], apiKeys: [], usage: [] });
    expect(multiple.usage.map(record => record.upstream)).toEqual(['up_a', 'up_b', 'up_a']);
    expect(multiple.usage).not.toContainEqual(expect.objectContaining({ upstream: null }));
  });

  it('authorizes historical usage by its actual upstream rather than key metadata', () => {
    const scoped = scopeUsageSnapshotForUser(snapshot(), { upstreamIds: ['up_a'] });

    expect(scoped.usage).toContainEqual(expect.objectContaining({ keyId: 'k1', upstream: 'up_a' }));
  });
});

describe('usage leaderboard', () => {
  it('builds top-four rankings by tokens, cost, and cache percent', () => {
    const snapshot: GlobalUsageSnapshot = {
      exportedAt: '2026-06-22T12:34:00.000Z',
      users: [
        { id: 1, username: 'alice', deletedAt: null },
        { id: 2, username: 'bob', deletedAt: null },
        { id: 3, username: 'carol', deletedAt: null },
        { id: 4, username: 'dave', deletedAt: null },
        { id: 5, username: 'erin', deletedAt: null },
      ],
      apiKeys: [exportKey('k1', 1), exportKey('k2', 2), exportKey('k3', 3), exportKey('k4', 4), exportKey('k5', 5)],
      usage: [
        usageRecord('k1', 'up', '2026-06-22T12', 1, [
          metric('input_tokens', '100', '0.00001'),
          metric('input_cache_read_tokens', '100', '0.000001'),
          metric('output_tokens', '100', '0.00005'),
        ]),
        usageRecord('k2', 'up', '2026-06-21T01', 1, [
          metric('input_tokens', '600', '0.000001'),
          metric('output_tokens', '600', '0.000001'),
        ]),
        usageRecord('k3', 'up', '2026-06-22T10', 1, [
          metric('input_tokens', '10', '0.000001'),
          metric('input_cache_read_tokens', '90', '0.000001'),
        ]),
        usageRecord('k4', 'up', '2026-06-20T10', 1, [
          metric('input_tokens', '250', '0.000001'),
          metric('output_tokens', '100', '0.000001'),
        ]),
        usageRecord('k5', 'up', '2026-06-19T10', 1, [
          metric('input_tokens', '20', '0.001'),
          metric('output_tokens', '10', '0.001'),
        ]),
        usageRecord('k4', 'up', '2026-06-01T10', 1, [metric('input_tokens', '99999999', '0.001')]),
        usageRecord('missing', 'up', '2026-06-22T12', 1, [metric('input_tokens', '99999999', '0.001')]),
      ],
    };

    const userSnapshot = scopeUsageSnapshotForUser(snapshot, { upstreamIds: null });
    const report = summarizeUsageLeaderboard(userSnapshot);

    expect(report.startAt).toBe('2026-06-15T12:34:00.000Z');
    expect(report.endAt).toBe('2026-06-22T12:34:00.000Z');
    expect(report.byTokens.map(entry => entry.username)).toEqual(['bob', 'dave', 'alice', 'carol']);
    expect(report.byCost.map(entry => entry.username)).toEqual(['erin', 'alice', 'bob', 'dave']);
    expect(report.byCachePercent.map(entry => entry.username)).toEqual(['carol', 'alice', 'bob', 'dave']);
    expect(report.byCachePercent[0]?.cachePercent).toBe(90);
    expect(report.totals.tokens).toBe(1980);
    expect(report.totals.cost).toBeCloseTo(0.03775);
    expect(report.totals.cacheReadTokens).toBe(190);

    const oneDayReport = summarizeUsageLeaderboard(userSnapshot, 1);
    expect(oneDayReport.startAt).toBe('2026-06-21T12:34:00.000Z');
    expect(oneDayReport.byTokens.map(entry => entry.username)).toEqual(['alice', 'carol']);
    expect(oneDayReport.totals.tokens).toBe(400);
    expect(oneDayReport.totals.cost).toBeCloseTo(0.0062);
    expect(oneDayReport.totals.cacheReadTokens).toBe(190);
  });

  it('limits every displayed user statistic to the requesting user scope', () => {
    const snapshot: GlobalUsageSnapshot = {
      exportedAt: '2026-06-22T12:34:00.000Z',
      users: [
        { id: 1, username: 'alice', deletedAt: null },
        { id: 2, username: 'bob', deletedAt: null },
        { id: 3, username: 'denied-only', deletedAt: null },
      ],
      apiKeys: [exportKey('k1', 1), exportKey('k2', 2), exportKey('k3', 3)],
      usage: [
        usageRecord('k1', 'up_a', '2026-06-22T12', 2, [
          metric('input_tokens', '80', '0.01'),
          metric('input_cache_read_tokens', '20', '0.01'),
        ]),
        usageRecord('k1', 'up_b', '2026-06-22T12', 900, [
          metric('input_tokens', '9000', '1'),
          metric('input_cache_read_tokens', '9000', '1'),
        ]),
        usageRecord('k2', 'up_a', '2026-06-22T12', 1, [
          metric('input_tokens', '100', '0.001'),
          metric('input_cache_read_tokens', '300', '0.001'),
        ]),
        usageRecord('k2', null, '2026-06-22T12', 800, [
          metric('input_cache_read_tokens', '8000', '1'),
        ]),
        usageRecord('k3', 'up_b', '2026-06-22T12', 700, [
          metric('output_tokens', '7000', '1'),
        ]),
      ],
    };

    const userSnapshot = scopeUsageSnapshotForUser(snapshot, { upstreamIds: ['up_a'] });
    const report = summarizeUsageLeaderboard(userSnapshot, 7, 4, new Date('2026-06-22T12:34:00.000Z'));

    expect(report.byTokens.map(entry => entry.username)).toEqual(['bob', 'alice']);
    expect(report.byCost.map(entry => entry.username)).toEqual(['alice', 'bob']);
    expect(report.byCachePercent.map(entry => entry.username)).toEqual(['bob', 'alice']);
    expect(report.byTokens.find(entry => entry.username === 'alice')).toMatchObject({
      totals: {
        requests: 2,
        tokens: { input: 80, input_cache_read: 20 },
        cost: 1,
      },
      cachePercent: 20,
    });
    expect(report.byTokens.find(entry => entry.username === 'bob')).toMatchObject({
      totals: {
        requests: 1,
        tokens: { input: 100, input_cache_read: 300 },
        cost: 0.4,
      },
      cachePercent: 75,
    });
    expect(report.totals.tokens).toBe(500);
    expect(report.totals.cost).toBeCloseTo(1.4);
    expect(report.totals.cacheReadTokens).toBe(320);
    expect(report.byTokens.map(entry => entry.username)).not.toContain('denied-only');
  });
});

describe('usage quota estimate', () => {
  it('infers user used percent from token share and upstream quota used percent', () => {
    const snapshot: GlobalUsageSnapshot = {
      exportedAt: '2026-06-22T00:00:00.000Z',
      users: [
        { id: 7, username: 'alice', deletedAt: null },
        { id: 8, username: 'bob', deletedAt: null },
      ],
      apiKeys: [exportKey('k1', 7), exportKey('k2', 8)],
      usage: [
        usageRecord('k1', 'up1', '2026-06-21T01', 1, [metric('input_tokens', '100', '0.000001')]),
        usageRecord('k2', 'up1', '2026-06-21T01', 3, [metric('input_tokens', '300', '0.000001')]),
        usageRecord('k1', 'up2', '2026-06-21T01', 1, [metric('input_tokens', '999', '0.000001')]),
      ],
    };

    const report = summarizeUsageQuotaEstimate(7, 'up1', {
      label: 'Quota window',
      startAt: '2026-06-21T00:00:00.000Z',
      endAt: '2026-06-22T00:00:00.000Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-22T00',
    }, 80, snapshot, 4);

    expect(report.userTokenSharePercent).toBe(25);
    expect(report.userUpstreamQuotaSharePercent).toBe(20);
    expect(report.equalSharePercent).toBe(25);
    expect(report.estimatedUserUsedPercent).toBe(80);
  });
});
