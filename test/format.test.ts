import { describe, expect, it } from 'vitest';

import {
  formatBindDeepLinkSuccess,
  formatInfo,
  formatKeys,
  formatQuotaEstimate,
  formatQuotaEstimateNotification,
  formatQuotaEstimateVerbose,
  formatQuotaWindowNotification,
  formatStartHelp,
  formatUpstreamDetail,
  formatUpstreamList,
  formatUsageLeaderboard,
  splitMessage,
} from '../src/format.js';
import type { ApiKeyRecord, Binding, UpstreamRecord } from '../src/types.js';
import type { UsageLeaderboardReport, UsageQuotaEstimate, UsageWindowReport } from '../src/usage.js';

describe('formatters', () => {
  it('splits long Telegram HTML only at independently valid boundaries', () => {
    const text = [
      `<b>${'a'.repeat(60)}</b>`,
      `<code>${'x&lt;&amp;&gt;'.repeat(40)}</code>`,
      `<b>${'z'.repeat(60)}</b>`,
    ].join('\n');
    const chunks = splitMessage(text, 80);

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every(chunk => chunk.length <= 80)).toBe(true);
    for (const chunk of chunks) {
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length);
      expect((chunk.match(/<code>/g) ?? []).length).toBe((chunk.match(/<\/code>/g) ?? []).length);
      const lastAmpersand = chunk.lastIndexOf('&');
      const lastSemicolon = chunk.lastIndexOf(';');
      expect(lastAmpersand <= lastSemicolon || lastAmpersand === -1).toBe(true);
    }
  });

  it('escapes dynamic upstream fields for Telegram HTML', () => {
    const upstream: UpstreamRecord = {
      id: 'up_<a>&',
      kind: 'codex',
      name: 'Codex <main> & shared',
      enabled: true,
      sort_order: 1,
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
    };

    const text = formatUpstreamList([upstream]);
    expect(text).toContain('Codex &lt;main&gt; &amp; shared');
    expect(text).toContain('<code>up_&lt;a&gt;&amp;</code>');
  });

  it('shows the selected latest-reset window while keeping provider slots diagnostic', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      kind: 'codex',
      name: 'Codex',
      enabled: true,
      sort_order: 1,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      flag_overrides: {},
      flag_defaults: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      model_prefix: null,
      color: null,
      config: {},
      state: null,
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
    };

    const list = formatUpstreamList([upstream]);
    expect(list).toContain('quota <code>premium</code>: <b>75.0%</b> | resets <code>2026-07-08T00:00:00.000Z</code>');
    expect(list).not.toContain('15.0%');

    const detail = formatUpstreamDetail(upstream, [], null);
    expect(detail).toContain('<b>Selected window</b>: <b>75.0%</b> | 10,080 min | resets <code>2026-07-08T00:00:00.000Z</code>');
    expect(detail).toContain('<b>Primary slot</b>: <b>15.0%</b> | 300 min | resets <code>2026-07-01T05:00:00.000Z</code>');
    expect(detail).toContain('<b>Secondary slot</b>: <b>75.0%</b> | 10,080 min | resets <code>2026-07-08T00:00:00.000Z</code>');
  });

  it('escapes generated key secrets, hides them, and keeps them copyable', () => {
    const key: ApiKeyRecord = {
      id: 'key_1',
      name: 'main <prod>',
      key: 'sk-<test>&',
      created_at: '2026-06-21T00:00:00.000Z',
      last_used_at: null,
      upstream_ids: ['up_a'],
      dump_retention_seconds: null,
      responses_retention_seconds: 0,
    };

    const text = formatKeys([key]);
    expect(text).toContain('<b>main &lt;prod&gt;</b>');
    expect(text).toContain('<b>Secret</b>: <tg-spoiler><code>sk-&lt;test&gt;&amp;</code></tg-spoiler>');
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
      bindingId: 1,
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
      kind: 'codex',
      name: 'Codex <main>&',
      enabled: true,
      sort_order: 1,
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
    };
    const report: UsageQuotaEstimate = {
      window: {
        label: 'Quota window',
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
    expect(text).toContain('<b>Upstream quota used</b>:\n[||||||||||||   ] <b>80.0%</b>');
    expect(text).toContain('<b>Estimated your used</b>:\n[||||||||||||   ] <b>80.0%</b> of your equal share');
    expect(text).toContain('(Assumed 4 users)');
    expect(text).toContain('Actual per-user quota pressure depends on every upstream user');

    const highUsageText = formatQuotaEstimate(upstream, { ...report, estimatedUserUsedPercent: 135 });
    expect(highUsageText).toContain('<b>Estimated your used</b>:\n[|||||||||||||||] <b>135.0%</b> of your equal share');
  });

  it('formats verbose quota estimates with detailed fields', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      kind: 'codex',
      name: 'Codex <main>&',
      enabled: true,
      sort_order: 1,
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
    };
    const report: UsageQuotaEstimate = {
      window: {
        label: 'Quota window',
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
        label: 'Quota window',
        startAt: '2026-06-15T00:00:00.000Z',
        endAt: '2026-06-22T00:00:00.000Z',
        startHour: '2026-06-15T00',
        endHour: '2026-06-22T00',
        quotaActiveLimit: 'premium',
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

    expect(text).toContain('<b>Upstream quota used</b>:\n[|||            ] <b>18.0%</b>');
    expect(text).toContain('<b>Estimated your used</b>:');
    expect(text).toContain('(Assumed 4 users)');
    expect(text).not.toContain('<b>Active limit</b>');
    expect(text).not.toContain('<b>Quota estimate</b>');
    expect(text).not.toContain('Reset in ');
    expect(text).not.toContain('Estimate only');
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

  it('formats quota window refresh notifications', () => {
    const upstream: UpstreamRecord = {
      id: 'up_a',
      kind: 'codex',
      name: 'Codex <main>&',
      enabled: true,
      sort_order: 1,
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
    };
    const report: UsageWindowReport = {
      window: {
        label: 'Quota window',
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

    const text = formatQuotaWindowNotification(upstream, report, '<b>Quota estimate</b>');

    expect(text).toContain('<b>Quota window refreshed</b>');
    expect(text).toContain('<b>Codex &lt;main&gt;&amp;</b> <code>up_a</code>');
    expect(text).toContain('<b>Your upstream tokens</b>: <b>100</b>');
    expect(text).toContain('<b>Requests</b>: <b>1</b> / 4');
    expect(text).toContain('<b>Upstream cost</b>: <b>$0.000100</b> / $0.000400');
    expect(text).toContain('\n\n<b>Quota estimate</b>');
    expect(text).not.toContain('<b>Window note</b>');

    const noted = formatQuotaWindowNotification(upstream, report, '<b>Quota estimate</b>', 'Manual <refresh>&');
    expect(noted).toContain('<b>Window note</b>: Manual &lt;refresh&gt;&amp;');
  });
});
