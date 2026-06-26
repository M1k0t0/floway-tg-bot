import { describe, expect, it } from 'vitest';

import {
  canShareUpstreamQuota,
  canViewLeaderboard,
  filterUpstreamsForUser,
  parseLeaderboardArgs,
  parseNewKeyArgs,
  parseQuotaArgs,
  selectUpstream,
} from '../src/bot.js';
import type { UpstreamRecord } from '../src/types.js';

const upstream = (id: string): UpstreamRecord => ({
  id,
  provider: 'codex',
  name: id,
  enabled: true,
  sort_order: 0,
  created_at: '2026-06-21T00:00:00.000Z',
  updated_at: '2026-06-21T00:00:00.000Z',
  flag_overrides: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  config: {},
  state: null,
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

describe('leaderboard permission', () => {
  it('requires global telemetry permission', () => {
    expect(canViewLeaderboard({ canViewGlobalTelemetry: true })).toBe(true);
    expect(canViewLeaderboard({ canViewGlobalTelemetry: false })).toBe(false);
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
