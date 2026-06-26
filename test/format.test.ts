import { describe, expect, it } from 'vitest';

import {
  formatBindDeepLinkSuccess,
  formatInfo,
  formatKeys,
  formatQuotaEstimate,
  formatQuotaEstimateInsufficient,
  formatQuotaEstimateNotification,
  formatQuotaEstimateVerbose,
  formatSecondaryWindowNotification,
  formatStartHelp,
  formatUpstreamList,
  formatUsageLeaderboard,
} from '../src/format.js';
import type { ApiKeyRecord, Binding, UpstreamRecord } from '../src/types.js';
import type { UsageLeaderboardReport, UsageQuotaEstimate, UsageWindowReport } from '../src/usage.js';

describe('formatters', () => {
  it('escapes dynamic upstream fields for Telegram HTML', () => {
    const upstream: UpstreamRecord = {
      id: 'up_<a>&',
      provider: 'codex',
      name: 'Codex <main> & shared',
      enabled: true,
      sort_order: 1,
      created_at: '2026-06-21T00:00:00.000Z',
      updated_at: '2026-06-21T00:00:00.000Z',
      flag_overrides: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      config: {},
      state: null,
    };

    const text = formatUpstreamList([upstream]);
    expect(text).toContain('Codex &lt;main&gt; &amp; shared');
    expect(text).toContain('<code>up_&lt;a&gt;&amp;</code>');
  });

  it('escapes generated key secrets and labels them clearly', () => {
    const key: ApiKeyRecord = {
      id: 'key_1',
      name: 'main <prod>',
      key: 'sk-test',
      created_at: '2026-06-21T00:00:00.000Z',
      last_used_at: null,
      upstream_ids: ['up_a'],
    };

    const text = formatKeys([key]);
    expect(text).toContain('<b>main &lt;prod&gt;</b>');
    expect(text).toContain('<code>up_a</code>');
  });

  it('formats endpoint info and escapes the base URL', () => {
    const text = formatInfo('https://floway.example/<edge>&');
    expect(text).toContain('<b>Floway client info</b>');
    expect(text).toContain('<code>https://floway.example/&lt;edge&gt;&amp;/v1/responses</code>');
    expect(text).toContain('Use /keys to view your keys.');
    expect(text).toContain('Authorization: Bearer &lt;key&gt;');
  });

  it('shows bind help only before the user is bound', () => {
    const unbound = formatStartHelp(null);
    expect(unbound).toContain('<code>/bind &lt;username&gt; &lt;password&gt;</code>');

    const binding: Binding = {
      telegramUserId: 'tg1',
      flowayUserId: 7,
      username: 'alice <prod>&',
      flowaySession: 'session',
      createdAt: '2026-06-21T00:00:00.000Z',
      updatedAt: '2026-06-21T00:00:00.000Z',
    };
    const bound = formatStartHelp(binding);
    expect(bound).not.toContain('/bind');
    expect(bound).toContain('<b>Signed in</b>: alice &lt;prod&gt;&amp;');
    expect(bound).not.toContain('<code>7</code>');
    expect(bound).toContain('<code>/leaderboard [1d|7d|30d]</code>');
  });

  it('echoes deep-link credentials with the password hidden behind a spoiler', () => {
    const text = formatBindDeepLinkSuccess('alice <prod>&', 'pw<secret>&');
    expect(text).toContain('<b>Floway account bound</b>');
    expect(text).toContain('<b>Username</b>: alice &lt;prod&gt;&amp;');
    expect(text).toContain('<b>Password</b>: <tg-spoiler>pw&lt;secret&gt;&amp;</tg-spoiler>');
  });

  it('formats compact quota estimates by default', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      provider: 'codex',
      name: 'Codex <main>&',
      enabled: true,
      sort_order: 1,
      created_at: '2026-06-21T00:00:00.000Z',
      updated_at: '2026-06-21T00:00:00.000Z',
      flag_overrides: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      config: {},
      state: null,
    };
    const report: UsageQuotaEstimate = {
      window: {
        label: 'Secondary window',
        startAt: '2026-06-15T00:00:00.000Z',
        endAt: '2026-06-22T00:00:00.000Z',
        startHour: '2026-06-15T00',
        endHour: '2026-06-22T00',
      },
      upstreamUsedPercent: 80,
      user: { requests: 1, tokens: { input: 100 }, cost: 0.0001 },
      upstream: { requests: 4, tokens: { input: 400 }, cost: 0.0004 },
      userTokenSharePercent: 25,
      userUpstreamQuotaSharePercent: 20,
      nonAdminUserCount: 4,
      equalSharePercent: 25,
      estimatedUserUsedPercent: 80,
    };

    const text = formatQuotaEstimate(upstream, report);
    expect(text).toContain('<b>Quota estimate</b>\n\n<b>Codex &lt;main&gt;&amp;</b>');
    expect(text).not.toContain('<code>up_a</code>');
    expect(text).toContain('Reset in ');
    expect(text).toContain('<b>Upstream secondary used</b>:\n[||||||||||||   ] <b>80.0%</b>');
    expect(text).toContain('<b>Estimated your used</b>:\n[||||||||||||   ] <b>80.0%</b> of your equal share');
    expect(text).toContain('(Assumed 4 users)');
    expect(text).toContain('Actual per-user quota pressure depends on every upstream user');

    const highUsageText = formatQuotaEstimate(upstream, { ...report, estimatedUserUsedPercent: 135 });
    expect(highUsageText).toContain('<b>Estimated your used</b>:\n[|||||||||||||||] <b>135.0%</b> of your equal share');
  });

  it('formats verbose quota estimates with detailed fields', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      provider: 'codex',
      name: 'Codex <main>&',
      enabled: true,
      sort_order: 1,
      created_at: '2026-06-21T00:00:00.000Z',
      updated_at: '2026-06-21T00:00:00.000Z',
      flag_overrides: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      config: {},
      state: null,
    };
    const report: UsageQuotaEstimate = {
      window: {
        label: 'Secondary window',
        startAt: '2026-06-15T00:00:00.000Z',
        endAt: '2026-06-22T00:00:00.000Z',
        startHour: '2026-06-15T00',
        endHour: '2026-06-22T00',
      },
      upstreamUsedPercent: 80,
      user: { requests: 1, tokens: { input: 100 }, cost: 0.0001 },
      upstream: { requests: 4, tokens: { input: 400 }, cost: 0.0004 },
      userTokenSharePercent: 25,
      userUpstreamQuotaSharePercent: 20,
      nonAdminUserCount: 4,
      equalSharePercent: 25,
      estimatedUserUsedPercent: 80,
    };

    const text = formatQuotaEstimateVerbose(upstream, report);
    expect(text).toContain('<b>Quota estimate</b> <b>Codex &lt;main&gt;&amp;</b> <code>up_a</code>');
    expect(text).toContain('<b>Your upstream tokens</b>: <b>100</b>');
    expect(text).toContain('<b>Your token share</b>: [||||           ] <b>25.0%</b>');
    expect(text).toContain('<b>Estimated your used</b>: [||||||||||||   ] <b>80.0%</b> of your equal share');
  });

  it('formats notification quota estimates without the command header or caveat', () => {
    const report: UsageQuotaEstimate = {
      window: {
        label: 'Secondary window',
        startAt: '2026-06-15T00:00:00.000Z',
        endAt: '2026-06-22T00:00:00.000Z',
        startHour: '2026-06-15T00',
        endHour: '2026-06-22T00',
      },
      upstreamUsedPercent: 18,
      user: { requests: 1, tokens: { input: 100 }, cost: 0.0001 },
      upstream: { requests: 4, tokens: { input: 400 }, cost: 0.0004 },
      userTokenSharePercent: 25,
      userUpstreamQuotaSharePercent: 4.5,
      nonAdminUserCount: 4,
      equalSharePercent: 25,
      estimatedUserUsedPercent: 18,
    };

    const text = formatQuotaEstimateNotification(report);

    expect(text).toContain('<b>Upstream secondary used</b>:\n[|||            ] <b>18.0%</b>');
    expect(text).toContain('<b>Estimated your used</b>:');
    expect(text).toContain('(Assumed 4 users)');
    expect(text).not.toContain('<b>Quota estimate</b>');
    expect(text).not.toContain('Reset in ');
    expect(text).not.toContain('Estimate only');
  });

  it('formats low-information quota estimates after a limit refresh', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      provider: 'codex',
      name: 'Codex main',
      enabled: true,
      sort_order: 1,
      created_at: '2026-06-21T00:00:00.000Z',
      updated_at: '2026-06-21T00:00:00.000Z',
      flag_overrides: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      config: {},
      state: null,
    };

    const text = formatQuotaEstimateInsufficient(
      upstream,
      '2026-06-15T00:00:00.000Z',
      '2026-06-22T00:00:00.000Z',
      0.4,
    );
    expect(text).toContain('<b>Upstream secondary used</b>:\n[|              ] <b>0.40%</b>');
    expect(text).toContain('Not enough usage data yet. The limit probably just reset, so go make some requests.');
  });

  it('formats leaderboard rows and escapes usernames', () => {
    const report: UsageLeaderboardReport = {
      days: 7,
      startAt: '2026-06-15T12:34:00.000Z',
      endAt: '2026-06-22T12:34:00.000Z',
      exportedAt: '2026-06-22T12:34:00.000Z',
      totals: { tokens: 60, cost: 0.246912, cacheReadTokens: 20 },
      byTokens: [{
        userId: 7,
        username: 'alice <prod>&',
        totals: { requests: 1, tokens: { input: 10, input_cache_read: 5 }, cost: 0.123456 },
        cachePercent: 33.3333333333,
      }],
      byCost: [{
        userId: 7,
        username: 'alice <prod>&',
        totals: { requests: 1, tokens: { input: 10, input_cache_read: 5 }, cost: 0.123456 },
        cachePercent: 33.3333333333,
      }],
      byCachePercent: [{
        userId: 7,
        username: 'alice <prod>&',
        totals: { requests: 1, tokens: { input: 10, input_cache_read: 5 }, cost: 0.123456 },
        cachePercent: 33.3333333333,
      }],
    };

    const text = formatUsageLeaderboard(report);
    expect(text).toContain('<b>Leaderboard</b> <b>7d</b>');
    expect(text).toContain('1. <b>alice &lt;prod&gt;&amp;</b> - <b>15</b> tokens | <b>25.0%</b>');
    expect(text).not.toContain('<code>#7</code>');
    expect(text).toContain('1. <b>alice &lt;prod&gt;&amp;</b> - <b>$0.123456</b> | <b>50.0%</b>');
    expect(text).toContain('1. <b>alice &lt;prod&gt;&amp;</b> - <b>33.3%</b> cache | <b>25.0%</b> cached share');
    expect(text).not.toContain('tokens | $');
  });

  it('formats secondary window refresh notifications', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      provider: 'codex',
      name: 'Codex <main>&',
      enabled: true,
      sort_order: 1,
      created_at: '2026-06-21T00:00:00.000Z',
      updated_at: '2026-06-21T00:00:00.000Z',
      flag_overrides: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      config: {},
      state: null,
    };
    const report: UsageWindowReport = {
      window: {
        label: 'Secondary window',
        startAt: '2026-06-15T00:00:00.000Z',
        endAt: '2026-06-22T00:00:00.000Z',
        startHour: '2026-06-15T00',
        endHour: '2026-06-22T00',
        upstreamPercent: 80,
      },
      user: { requests: 1, tokens: { input: 100 }, cost: 0.0001 },
      upstream: { requests: 4, tokens: { input: 400 }, cost: 0.0004 },
      userTokenSharePercent: 25,
      userRequestSharePercent: 25,
    };

    const text = formatSecondaryWindowNotification(upstream, report, '<b>Quota estimate</b>');

    expect(text).toContain('<b>Secondary window refreshed</b>');
    expect(text).toContain('<b>Codex &lt;main&gt;&amp;</b> <code>up_a</code>');
    expect(text).toContain('<b>Floway upstream used</b>: <b>80.0%</b>');
    expect(text).toContain('<b>Your upstream tokens</b>: <b>100</b>');
    expect(text).toContain('<b>Your upstream cost</b>: <b>$0.000100</b>');
    expect(text).toContain('\n\n<b>Quota estimate</b>');
  });
});
