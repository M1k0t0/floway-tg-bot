import { describe, expect, it } from 'vitest';

import {
  computeWindowsFromQuota,
  recordCostUsd,
  summarizeUsageWindow,
  unitPriceForDimension,
} from '../src/usage.js';
import type { SanitizedExportSnapshot, TokenUsageResponse, UsageRecord } from '../src/types.js';

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
  it('uses raw export usage for upstream shares and user session usage for authoritative cost', () => {
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
    const userUsage: TokenUsageResponse = {
      records: [
        { keyId: 'k1', model: 'm', hour: '2026-06-21T01', requests: 2, tokens: { input: 100 }, cost: 12.34 },
        { keyId: 'k1', model: 'm', hour: '2026-06-21T05', requests: 2, tokens: { input: 100 }, cost: 99 },
      ],
      keys: [{ id: 'k1', name: 'A', createdAt: '2026-06-20T00:00:00.000Z' }],
    };

    const report = summarizeUsageWindow(7, 'up1', {
      label: 'Primary window',
      startAt: '2026-06-21T00:00:00.000Z',
      endAt: '2026-06-21T05:00:00.000Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-21T05',
    }, userUsage, snapshot);

    expect(report.user.requests).toBe(2);
    expect(report.upstream.requests).toBe(8);
    expect(report.userTokenSharePercent).toBe(25);
    expect(report.userRequestSharePercent).toBe(25);
    expect(report.authoritativeUserCost).toBe(12.34);
  });

  it('handles zero upstream totals without percentages', () => {
    const report = summarizeUsageWindow(1, 'up', {
      label: 'Primary window',
      startAt: '2026-06-21T00:00:00.000Z',
      endAt: '2026-06-21T01:00:00.000Z',
      startHour: '2026-06-21T00',
      endHour: '2026-06-21T01',
    }, { records: [], keys: [] }, { exportedAt: 'x', users: [], apiKeys: [], usage: [] });
    expect(report.userTokenSharePercent).toBeNull();
    expect(report.userRequestSharePercent).toBeNull();
  });
});
