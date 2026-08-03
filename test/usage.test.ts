import { describe, expect, it } from 'vitest';

import {
  addUsageRecord,
  buildQuotaWindow,
  emptyTotals,
  recordCostUsd,
  selectQuotaWindowForUpstream,
  summarizeUsageLeaderboard,
  summarizeUsageQuotaEstimate,
  summarizeUsageWindow,
  tokenTotal,
} from '../src/usage.js';
import type {
  BillingMetric,
  SanitizedExportApiKey,
  SanitizedExportSnapshot,
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
): UsageRecord => ({
  keyId,
  model: 'm',
  upstream,
  modelKey: 'm',
  hour,
  pricingSelector: {},
  requests,
  metrics,
});

const exportKey = (id: string, userId: number): SanitizedExportApiKey => ({
  id,
  userId,
  name: id,
  createdAt: '2026-06-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
});

describe('usage windows', () => {
  it('derives exact boundaries and Floway hour buckets from the primary reset window', () => {
    const window = buildQuotaWindow({
      observed_at: '2026-06-21T00:31:00.000Z',
      primary_used_percent: 90,
      primary_window_minutes: 10080,
      primary_reset_after_at: '2026-06-28T00:30:45.123Z',
    });

    expect(window).toMatchObject({
      label: 'Primary window',
      startAt: '2026-06-21T00:30:45.123Z',
      endAt: '2026-06-28T00:30:45.123Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-28T00',
      upstreamPercent: 90,
    });
  });

  it('returns no window when quota is unavailable or invalid', () => {
    expect(buildQuotaWindow(null)).toBeNull();
    expect(buildQuotaWindow({})).toBeNull();
    expect(buildQuotaWindow({ primary_window_minutes: 10080, primary_reset_after_at: 'x' })).toBeNull();
    expect(buildQuotaWindow({
      primary_window_minutes: 10080,
      primary_reset_after_at: '2026-06-28T00:00:00.000Z',
    })).toBeNull();
  });

  it('reads a primary quota window only from Codex premium snapshots', () => {
    const codexQuota = {
      observed_at: '2026-06-21T00:00:00.000Z',
      active_limit: 'premium',
      primary_used_percent: 90,
      primary_window_minutes: 10080,
      primary_reset_after_at: '2026-06-28T00:00:00.000Z',
    };

    expect(selectQuotaWindowForUpstream({ id: 'up', kind: 'codex', codex_quota: { 'chatgpt-plus': codexQuota } })).not.toBeNull();
    expect(selectQuotaWindowForUpstream({ id: 'up', kind: 'custom', codex_quota: { 'chatgpt-plus': codexQuota } })).toBeNull();
  });

  it('uses only the premium active-limit bucket for quota windows', () => {
    const window = selectQuotaWindowForUpstream({
      id: 'up',
      kind: 'codex',
      codex_quota: {
        enterprise: {
          observed_at: '2026-06-21T00:01:00.000Z',
          active_limit: 'enterprise',
          primary_used_percent: 20,
          primary_window_minutes: 10080,
          primary_reset_after_at: '2026-06-28T00:00:00.000Z',
        },
        premium: {
          observed_at: '2026-06-21T00:00:00.000Z',
          active_limit: 'premium',
          primary_used_percent: 30,
          primary_window_minutes: 10080,
          primary_reset_after_at: '2026-06-28T02:00:00.000Z',
        },
      },
    });

    expect(window).toEqual(expect.objectContaining({
      label: 'Primary window',
      quotaBucketKey: 'premium',
      quotaActiveLimit: 'premium',
      upstreamPercent: 30,
    }));
    expect(selectQuotaWindowForUpstream({ id: 'up', kind: 'codex', codex_quota: { enterprise: {
      observed_at: '2026-06-21T00:01:00.000Z',
      active_limit: 'enterprise',
      primary_used_percent: 20,
      primary_window_minutes: 10080,
      primary_reset_after_at: '2026-06-28T00:00:00.000Z',
    } } })).toBeNull();
  });

  it('matches premium snapshots with normalized active-limit and map-key names', () => {
    expect(selectQuotaWindowForUpstream({ id: 'up', kind: 'codex', codex_quota: { 'chatgpt-plus': {
      observed_at: '2026-06-21T00:00:00.000Z',
      active_limit: ' Premium ',
      primary_used_percent: 44,
      primary_window_minutes: 10080,
      primary_reset_after_at: '2026-06-28T00:00:00.000Z',
    } } })).toMatchObject({ quotaBucketKey: 'chatgpt-plus', upstreamPercent: 44 });
    expect(selectQuotaWindowForUpstream({ id: 'up', kind: 'codex', codex_quota: { premium: {
      observed_at: '2026-06-21T00:00:00.000Z',
      primary_used_percent: 55,
      primary_window_minutes: 10080,
      primary_reset_after_at: '2026-06-28T00:00:00.000Z',
    } } })).toMatchObject({ quotaBucketKey: 'premium', upstreamPercent: 55 });
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
    const snapshot: SanitizedExportSnapshot = {
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
      label: 'Primary window',
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
      label: 'Primary window',
      startAt: '2026-06-21T00:00:00.000Z',
      endAt: '2026-06-21T01:00:00.000Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-21T01',
    }, { exportedAt: 'x', users: [], apiKeys: [], usage: [] });
    expect(report.userTokenSharePercent).toBeNull();
    expect(report.userRequestSharePercent).toBeNull();
  });
});

describe('usage leaderboard', () => {
  it('builds top-four rankings by tokens, cost, and cache percent', () => {
    const snapshot: SanitizedExportSnapshot = {
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

    const report = summarizeUsageLeaderboard(snapshot);

    expect(report.startAt).toBe('2026-06-15T12:34:00.000Z');
    expect(report.endAt).toBe('2026-06-22T12:34:00.000Z');
    expect(report.byTokens.map(entry => entry.username)).toEqual(['bob', 'dave', 'alice', 'carol']);
    expect(report.byCost.map(entry => entry.username)).toEqual(['erin', 'alice', 'bob', 'dave']);
    expect(report.byCachePercent.map(entry => entry.username)).toEqual(['carol', 'alice', 'bob', 'dave']);
    expect(report.byCachePercent[0]?.cachePercent).toBe(90);
    expect(report.totals.tokens).toBe(1980);
    expect(report.totals.cost).toBeCloseTo(0.03775);
    expect(report.totals.cacheReadTokens).toBe(190);

    const oneDayReport = summarizeUsageLeaderboard(snapshot, 1);
    expect(oneDayReport.startAt).toBe('2026-06-21T12:34:00.000Z');
    expect(oneDayReport.byTokens.map(entry => entry.username)).toEqual(['alice', 'carol']);
    expect(oneDayReport.totals.tokens).toBe(400);
    expect(oneDayReport.totals.cost).toBeCloseTo(0.0062);
    expect(oneDayReport.totals.cacheReadTokens).toBe(190);
  });

  it('limits global records to the bound user upstream access list', () => {
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-22T12:34:00.000Z',
      users: [
        { id: 1, username: 'alice', deletedAt: null },
        { id: 2, username: 'bob', deletedAt: null },
        { id: 3, username: 'carol', deletedAt: null },
      ],
      apiKeys: [exportKey('k1', 1), exportKey('k2', 2), exportKey('k3', 3)],
      usage: [
        usageRecord('k1', 'up_a', '2026-06-22T12', 1, [metric('input_tokens', '100')]),
        usageRecord('k2', 'up_b', '2026-06-22T12', 1, [metric('input_tokens', '1000')]),
        usageRecord('k3', null, '2026-06-22T12', 1, [metric('input_tokens', '500')]),
      ],
    };

    const report = summarizeUsageLeaderboard(snapshot, 7, 4, new Date('2026-06-22T12:34:00.000Z'), ['up_a']);

    expect(report.byTokens.map(entry => entry.username)).toEqual(['alice']);
    expect(report.totals.tokens).toBe(100);
  });
});

describe('usage quota estimate', () => {
  it('infers user used percent from token share and upstream primary used percent', () => {
    const snapshot: SanitizedExportSnapshot = {
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
      label: 'Primary window',
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
