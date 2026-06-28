import { describe, expect, it } from 'vitest';

import {
  computeWindowsForUpstream,
  computeWindowsFromQuota,
  recordCostUsd,
  summarizeUsageLeaderboard,
  summarizeUsageQuotaEstimate,
  summarizeUsageWindow,
  unitPriceForDimension,
} from '../src/usage.js';
import type { SanitizedExportSnapshot, UsageRecord } from '../src/types.js';

describe('usage windows', () => {
  it('derives Floway hour buckets from Codex quota reset windows', () => {
    const windows = computeWindowsFromQuota({
      observed_at: '2026-06-21T00:00:00.000Z',
      primary_used_percent: 42,
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-06-21T05:30:00.000Z',
      secondary_used_percent: 90,
      secondary_window_minutes: 10080,
      secondary_reset_after_at: '2026-06-28T00:00:00.000Z',
    });

    expect(windows[0]).toMatchObject({
      label: 'Primary window',
      startHour: '2026-06-21T00',
      endHour: '2026-06-21T05',
      upstreamPercent: 42,
    });
    expect(windows[1]).toMatchObject({
      label: 'Secondary window',
      startHour: '2026-06-21T00',
      endHour: '2026-06-28T00',
      upstreamPercent: 90,
    });
  });

  it('returns no windows when quota is unavailable', () => {
    expect(computeWindowsFromQuota(null)).toEqual([]);
    expect(computeWindowsFromQuota({ observed_at: 'x' })).toEqual([]);
  });

  it('reads quota windows only from providers that expose a window quota snapshot', () => {
    const codexQuota = {
      observed_at: '2026-06-21T00:00:00.000Z',
      secondary_used_percent: 90,
      secondary_window_minutes: 10080,
      secondary_reset_after_at: '2026-06-28T00:00:00.000Z',
    };

    expect(computeWindowsForUpstream({ provider: 'codex', codex_quota: codexQuota })).toHaveLength(1);
    expect(computeWindowsForUpstream({ provider: 'custom', codex_quota: codexQuota })).toEqual([]);
  });
});

describe('usage cost', () => {
  it('matches Floway billing fallback logic', () => {
    expect(unitPriceForDimension({ input: 1 }, 'input_cache_read')).toBe(1);
    expect(unitPriceForDimension({ input: 1, input_cache_write: 2 }, 'input_cache_write_1h')).toBe(2);
    expect(unitPriceForDimension({ output: 9 }, 'input_cache_write_1h')).toBeNull();
  });

  it('computes USD cost from per-million token pricing snapshots', () => {
    const record: UsageRecord = {
      keyId: 'k1',
      model: 'm',
      upstream: 'up',
      modelKey: 'm',
      hour: '2026-06-21T00',
      requests: 1,
      tokens: { input: 1_000_000, input_cache_read: 1_000_000, output: 2_000_000 },
      cost: { input: 2, input_cache_read: 0.5, output: 10 },
    };
    expect(recordCostUsd(record)).toBe(22.5);
  });
});

describe('usage summary', () => {
  it('uses raw export usage for selected-upstream shares and cost', () => {
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-21T00:00:00.000Z',
      users: [{ id: 7, username: 'alice', deletedAt: null }],
      apiKeys: [
        { id: 'k1', userId: 7, name: 'A', createdAt: '2026-06-20T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k2', userId: 8, name: 'B', createdAt: '2026-06-20T00:00:00.000Z', upstreamIds: null, deletedAt: null },
      ],
      usage: [
        { keyId: 'k1', model: 'm', upstream: 'up1', modelKey: 'm', hour: '2026-06-21T01', requests: 2, tokens: { input: 100 }, cost: { input: 1 } },
        { keyId: 'k2', model: 'm', upstream: 'up1', modelKey: 'm', hour: '2026-06-21T01', requests: 6, tokens: { input: 300 }, cost: { input: 1 } },
        { keyId: 'k1', model: 'm', upstream: 'up2', modelKey: 'm', hour: '2026-06-21T01', requests: 100, tokens: { input: 999 }, cost: { input: 1 } },
        { keyId: 'k1', model: 'm', upstream: 'up1', modelKey: 'm', hour: '2026-06-21T05', requests: 100, tokens: { input: 999 }, cost: { input: 1 } },
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
      apiKeys: [
        { id: 'k1', userId: 1, name: 'A', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k2', userId: 2, name: 'B', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k3', userId: 3, name: 'C', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k4', userId: 4, name: 'D', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k5', userId: 5, name: 'E', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
      ],
      usage: [
        {
          keyId: 'k1',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-22T12',
          requests: 1,
          tokens: { input: 100, input_cache_read: 100, output: 100 },
          cost: { input: 10, input_cache_read: 1, output: 50 },
        },
        {
          keyId: 'k2',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-21T01',
          requests: 1,
          tokens: { input: 600, output: 600 },
          cost: { input: 1, output: 1 },
        },
        {
          keyId: 'k3',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-22T10',
          requests: 1,
          tokens: { input: 10, input_cache_read: 90 },
          cost: { input: 1, input_cache_read: 1 },
        },
        {
          keyId: 'k4',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-20T10',
          requests: 1,
          tokens: { input: 250, output: 100 },
          cost: { input: 1, output: 1 },
        },
        {
          keyId: 'k5',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-19T10',
          requests: 1,
          tokens: { input: 20, output: 10 },
          cost: { input: 1000, output: 1000 },
        },
        {
          keyId: 'k4',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-01T10',
          requests: 1,
          tokens: { input: 99_999_999 },
          cost: { input: 1000 },
        },
        {
          keyId: 'missing',
          model: 'm',
          upstream: 'up',
          modelKey: 'm',
          hour: '2026-06-22T12',
          requests: 1,
          tokens: { input: 99_999_999 },
          cost: { input: 1000 },
        },
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

  it('limits leaderboard records to the bound user upstream access list', () => {
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-22T12:34:00.000Z',
      users: [
        { id: 1, username: 'alice', deletedAt: null },
        { id: 2, username: 'bob', deletedAt: null },
        { id: 3, username: 'carol', deletedAt: null },
      ],
      apiKeys: [
        { id: 'k1', userId: 1, name: 'A', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k2', userId: 2, name: 'B', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k3', userId: 3, name: 'C', createdAt: '2026-06-01T00:00:00.000Z', upstreamIds: null, deletedAt: null },
      ],
      usage: [
        { keyId: 'k1', model: 'm', upstream: 'up_a', modelKey: 'm', hour: '2026-06-22T12', requests: 1, tokens: { input: 100 }, cost: null },
        { keyId: 'k2', model: 'm', upstream: 'up_b', modelKey: 'm', hour: '2026-06-22T12', requests: 1, tokens: { input: 1000 }, cost: null },
        { keyId: 'k3', model: 'm', upstream: null, modelKey: 'm', hour: '2026-06-22T12', requests: 1, tokens: { input: 500 }, cost: null },
      ],
    };

    const report = summarizeUsageLeaderboard(snapshot, 7, 4, new Date('2026-06-22T12:34:00.000Z'), ['up_a']);

    expect(report.byTokens.map(entry => entry.username)).toEqual(['alice']);
    expect(report.totals.tokens).toBe(100);
  });
});

describe('usage quota estimate', () => {
  it('infers user used percent from token share and upstream secondary used percent', () => {
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: '2026-06-22T00:00:00.000Z',
      users: [
        { id: 7, username: 'alice', deletedAt: null },
        { id: 8, username: 'bob', deletedAt: null },
      ],
      apiKeys: [
        { id: 'k1', userId: 7, name: 'A', createdAt: '2026-06-20T00:00:00.000Z', upstreamIds: null, deletedAt: null },
        { id: 'k2', userId: 8, name: 'B', createdAt: '2026-06-20T00:00:00.000Z', upstreamIds: null, deletedAt: null },
      ],
      usage: [
        { keyId: 'k1', model: 'm', upstream: 'up1', modelKey: 'm', hour: '2026-06-21T01', requests: 1, tokens: { input: 100 }, cost: { input: 1 } },
        { keyId: 'k2', model: 'm', upstream: 'up1', modelKey: 'm', hour: '2026-06-21T01', requests: 3, tokens: { input: 300 }, cost: { input: 1 } },
        { keyId: 'k1', model: 'm', upstream: 'up2', modelKey: 'm', hour: '2026-06-21T01', requests: 1, tokens: { input: 999 }, cost: { input: 1 } },
      ],
    };

    const report = summarizeUsageQuotaEstimate(7, 'up1', {
      label: 'Secondary window',
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
