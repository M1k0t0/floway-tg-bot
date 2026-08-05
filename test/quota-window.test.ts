import { describe, expect, it } from 'vitest';

import {
  classifyQuotaWindowTransition,
  matchesQuotaWindowCandidate,
  premiumQuotaSnapshots,
  quotaWindowToleranceMs,
  resolveQuotaWindowObservation,
  type QuotaWindowObservation,
} from '../src/quota-window.js';
import type { CodexQuotaSnapshot, UpstreamRecord } from '../src/types.js';

const snapshot = (
  observedAt: string,
  resetAt: string,
  overrides: Partial<CodexQuotaSnapshot> = {},
): CodexQuotaSnapshot => ({
  observed_at: observedAt,
  active_limit: 'premium',
  primary_window_minutes: 60,
  primary_reset_after_at: resetAt,
  primary_used_percent: 25,
  ...overrides,
});

const upstream = (
  codexQuota: unknown,
  kind = 'codex',
): UpstreamRecord => ({
  id: 'upstream-a',
  kind,
  name: 'Upstream A',
  enabled: true,
  sort_order: 0,
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
  codex_quota: codexQuota as Record<string, CodexQuotaSnapshot> | null,
});

const validObservation = (overrides: Partial<QuotaWindowObservation> = {}): QuotaWindowObservation => ({
  upstreamId: 'upstream-a',
  bucketKey: 'premium',
  activeLimit: 'premium',
  observedAt: '2026-07-01T01:00:00.000Z',
  observedAtMs: Date.parse('2026-07-01T01:00:00.000Z'),
  startAt: '2026-07-01T00:00:00.000Z',
  startMs: Date.parse('2026-07-01T00:00:00.000Z'),
  endAt: '2026-07-01T01:00:00.000Z',
  endMs: Date.parse('2026-07-01T01:00:00.000Z'),
  durationMs: 60 * 60_000,
  usedPercent: 25,
  ...overrides,
});

const observationAt = (
  startAt: string,
  endAt: string,
  observedAt = endAt,
  overrides: Partial<QuotaWindowObservation> = {},
): QuotaWindowObservation => validObservation({
  observedAt,
  observedAtMs: Date.parse(observedAt),
  startAt,
  startMs: Date.parse(startAt),
  endAt,
  endMs: Date.parse(endAt),
  durationMs: Date.parse(endAt) - Date.parse(startAt),
  ...overrides,
});

describe('premiumQuotaSnapshots', () => {
  it('keeps premium active-limit selection independent from window slots', () => {
    const fallback = snapshot('2026-07-01T03:00:00Z', '2026-07-01T04:00:00Z');
    delete fallback.active_limit;
    const explicit = snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z');
    const record = upstream({ premium: fallback, plus: explicit, enterprise: {
      ...explicit,
      active_limit: 'enterprise',
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: '2026-07-08T00:00:00Z',
    } });

    expect(premiumQuotaSnapshots(record)).toEqual([{ bucketKey: 'plus', snapshot: explicit }]);
  });
});

describe('resolveQuotaWindowObservation', () => {
  it('returns unsupported and missing without manufacturing observations', () => {
    expect(resolveQuotaWindowObservation(upstream(null, 'copilot'))).toEqual({ status: 'unsupported' });
    expect(resolveQuotaWindowObservation(upstream(null))).toEqual({ status: 'missing' });
    expect(resolveQuotaWindowObservation(upstream({}))).toEqual({ status: 'missing' });
    expect(resolveQuotaWindowObservation(upstream({ enterprise: snapshot(
      '2026-07-01T01:00:00Z',
      '2026-07-01T02:00:00Z',
      { active_limit: 'enterprise' },
    ) }))).toEqual({ status: 'missing' });
  });

  it('normalizes timestamps and accepts a primary-only snapshot', () => {
    const quota = snapshot(
      '2026-07-01T03:04:05.125+02:00',
      '2026-07-01T04:00:00+02:00',
      { active_limit: ' Premium ', primary_window_minutes: 90 },
    );
    delete quota.primary_used_percent;

    expect(resolveQuotaWindowObservation(upstream({ plus: quota }))).toEqual({
      status: 'valid',
      observation: {
        upstreamId: 'upstream-a',
        bucketKey: 'plus',
        activeLimit: 'premium',
        observedAt: '2026-07-01T01:04:05.125Z',
        observedAtMs: Date.parse('2026-07-01T01:04:05.125Z'),
        startAt: '2026-07-01T00:30:00.000Z',
        startMs: Date.parse('2026-07-01T00:30:00.000Z'),
        endAt: '2026-07-01T02:00:00.000Z',
        endMs: Date.parse('2026-07-01T02:00:00.000Z'),
        durationMs: 90 * 60_000,
        usedPercent: null,
      },
    });
  });

  it('rejects timestamp precision that cannot be represented exactly', () => {
    expect(resolveQuotaWindowObservation(upstream({ plus: snapshot(
      '2026-07-01T01:00:00.0001Z',
      '2026-07-01T02:00:00Z',
    ) }))).toEqual({ status: 'malformed' });
    expect(resolveQuotaWindowObservation(upstream({ plus: snapshot(
      '2026-07-01T01:00:00Z',
      '2026-07-01T02:00:00.0001Z',
    ) }))).toEqual({ status: 'malformed' });
  });

  it('accepts a secondary-only snapshot', () => {
    const quota: CodexQuotaSnapshot = {
      observed_at: '2026-07-01T01:00:00Z',
      active_limit: 'premium',
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: '2026-07-08T00:00:00Z',
      secondary_used_percent: 70,
    };

    expect(resolveQuotaWindowObservation(upstream({ plus: quota }))).toMatchObject({
      status: 'valid',
      observation: {
        startAt: '2026-07-01T00:00:00.000Z',
        endAt: '2026-07-08T00:00:00.000Z',
        durationMs: 10_080 * 60_000,
        usedPercent: 70,
      },
    });
  });

  it('treats fully populated zero-duration sibling slots as absent', () => {
    const observedAt = '2026-07-01T01:00:00Z';
    const primaryWindow = snapshot(observedAt, '2026-07-01T02:00:00Z', {
      secondary_window_minutes: 0,
      secondary_reset_after_at: observedAt,
      secondary_used_percent: 0,
    });
    const secondaryWindow: CodexQuotaSnapshot = {
      observed_at: observedAt,
      active_limit: 'premium',
      primary_window_minutes: 0,
      primary_reset_after_at: observedAt,
      primary_used_percent: 0,
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: '2026-07-08T00:00:00Z',
      secondary_used_percent: 70,
    };

    expect(resolveQuotaWindowObservation(upstream({ plus: primaryWindow }))).toMatchObject({
      status: 'valid',
      observation: { durationMs: 60 * 60_000, usedPercent: 25 },
    });
    expect(resolveQuotaWindowObservation(upstream({ plus: secondaryWindow }))).toMatchObject({
      status: 'valid',
      observation: { durationMs: 10_080 * 60_000, usedPercent: 70 },
    });
  });

  it('chooses the slot whose reset is latest when primary and secondary labels swap', () => {
    const fiveHour = {
      windowMinutes: 300,
      resetAt: '2026-07-01T05:00:00Z',
      usedPercent: 15,
    };
    const sevenDay = {
      windowMinutes: 10_080,
      resetAt: '2026-07-08T00:00:00Z',
      usedPercent: 75,
    };
    const primaryFiveHour = snapshot('2026-07-01T01:00:00Z', fiveHour.resetAt, {
      primary_window_minutes: fiveHour.windowMinutes,
      primary_used_percent: fiveHour.usedPercent,
      secondary_window_minutes: sevenDay.windowMinutes,
      secondary_reset_after_at: sevenDay.resetAt,
      secondary_used_percent: sevenDay.usedPercent,
    });
    const primarySevenDay = snapshot('2026-07-01T01:01:00Z', sevenDay.resetAt, {
      primary_window_minutes: sevenDay.windowMinutes,
      primary_used_percent: sevenDay.usedPercent,
      secondary_window_minutes: fiveHour.windowMinutes,
      secondary_reset_after_at: fiveHour.resetAt,
      secondary_used_percent: fiveHour.usedPercent,
    });

    for (const quota of [primaryFiveHour, primarySevenDay]) {
      expect(resolveQuotaWindowObservation(upstream({ plus: quota }))).toMatchObject({
        status: 'valid',
        observation: {
          endAt: '2026-07-08T00:00:00.000Z',
          durationMs: 10_080 * 60_000,
          usedPercent: 75,
        },
      });
    }
  });

  it('ranks reset before duration and duration only breaks equal-reset ties', () => {
    const laterShorter = snapshot('2026-07-01T01:00:00Z', '2026-07-08T00:00:00Z', {
      primary_window_minutes: 10_080,
      primary_used_percent: 70,
      secondary_window_minutes: 300,
      secondary_reset_after_at: '2026-07-08T01:00:00Z',
      secondary_used_percent: 20,
    });
    expect(resolveQuotaWindowObservation(upstream({ plus: laterShorter }))).toMatchObject({
      status: 'valid',
      observation: { endAt: '2026-07-08T01:00:00.000Z', durationMs: 300 * 60_000, usedPercent: 20 },
    });

    const equalReset = snapshot('2026-07-01T01:00:00Z', '2026-07-08T00:00:00Z', {
      primary_window_minutes: 300,
      primary_used_percent: 20,
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: '2026-07-08T00:00:00Z',
      secondary_used_percent: 70,
    });
    expect(resolveQuotaWindowObservation(upstream({ plus: equalReset }))).toMatchObject({
      status: 'valid',
      observation: { durationMs: 10_080 * 60_000, usedPercent: 70 },
    });
  });

  it('coalesces identical equal-rank slots and rejects conflicting facts', () => {
    const identical = snapshot('2026-07-01T01:00:00Z', '2026-07-08T00:00:00Z', {
      primary_window_minutes: 10_080,
      primary_used_percent: 70,
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: '2026-07-08T00:00:00Z',
      secondary_used_percent: 70,
    });
    expect(resolveQuotaWindowObservation(upstream({ plus: identical }))).toMatchObject({ status: 'valid' });

    expect(resolveQuotaWindowObservation(upstream({ plus: {
      ...identical,
      secondary_used_percent: 71,
    } }))).toEqual({ status: 'ambiguous' });
  });

  it('fails closed when a sibling slot is partial or malformed', () => {
    const invalidSiblings: Partial<CodexQuotaSnapshot>[] = [
      { secondary_window_minutes: 10_080 },
      { secondary_reset_after_at: '2026-07-08T00:00:00Z' },
      { secondary_used_percent: 70 },
      { secondary_window_minutes: 10_080, secondary_reset_after_at: 'bad' },
      { secondary_window_minutes: 0, secondary_reset_after_at: '2026-07-08T00:00:00Z' },
      { secondary_window_minutes: 0, secondary_reset_after_at: '2026-07-01T01:00:00Z' },
      { secondary_window_minutes: 0, secondary_reset_after_at: '2026-07-01T01:00:00Z', secondary_used_percent: 1 },
      { secondary_window_minutes: 10_080, secondary_reset_after_at: '2026-07-08T00:00:00Z', secondary_used_percent: 101 },
    ];

    for (const sibling of invalidSiblings) {
      expect(resolveQuotaWindowObservation(upstream({ plus: snapshot(
        '2026-07-01T01:00:00Z',
        '2026-07-01T02:00:00Z',
        sibling,
      ) }))).toEqual({ status: 'malformed' });
    }
  });

  it('uses the premium key only when active_limit is absent', () => {
    const fallback = snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z');
    delete fallback.active_limit;
    expect(resolveQuotaWindowObservation(upstream({ ' Premium ': fallback }))).toMatchObject({
      status: 'valid',
      observation: { bucketKey: 'premium', activeLimit: 'premium' },
    });
    expect(resolveQuotaWindowObservation(upstream({ premium: {
      ...fallback,
      active_limit: 'enterprise',
    } }))).toEqual({ status: 'missing' });
  });

  it('gives explicit premium candidates precedence over fallback candidates', () => {
    const fallback = snapshot('2026-07-01T03:00:00Z', '2026-07-08T00:00:00Z', {
      secondary_window_minutes: 300,
      secondary_reset_after_at: '2026-07-09T00:00:00Z',
    });
    delete fallback.active_limit;
    const result = resolveQuotaWindowObservation(upstream({
      premium: fallback,
      plus: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'),
    }));

    expect(result).toMatchObject({
      status: 'valid',
      observation: { bucketKey: 'plus', endAt: '2026-07-01T02:00:00.000Z' },
    });
  });

  it('validates runtime values without throwing', () => {
    const malformed: unknown[] = [
      { premium: null },
      { premium: [] },
      { premium: snapshot('not-a-date', '2026-07-01T02:00:00Z') },
      { premium: snapshot('2026-07-01 01:00:00', '2026-07-01T02:00:00Z') },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-02-30T02:00:00Z') },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00') },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_window_minutes: 0 }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_window_minutes: 1.5 }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_window_minutes: 44_641 }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_used_percent: Number.NaN }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_used_percent: 101 }) },
    ];

    for (const quota of malformed) {
      expect(() => resolveQuotaWindowObservation(upstream(quota))).not.toThrow();
      expect(resolveQuotaWindowObservation(upstream(quota))).toEqual({ status: 'malformed' });
    }
  });

  it('lets newer valid snapshots supersede older malformed data', () => {
    const result = resolveQuotaWindowObservation(upstream({
      broken: {
        observed_at: '2026-07-01T01:00:00Z',
        active_limit: 'premium',
        primary_window_minutes: 0,
        primary_reset_after_at: 'bad',
      },
      current: snapshot('2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z'),
    }));
    expect(result).toMatchObject({ status: 'valid', observation: { bucketKey: 'current' } });
  });

  it('keeps malformed status when malformed explicit data is not strictly older', () => {
    for (const observedAt of ['2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z', 'bad']) {
      const result = resolveQuotaWindowObservation(upstream({
        valid: snapshot('2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z'),
        broken: snapshot(observedAt, 'bad'),
      }));
      expect(result).toEqual({ status: 'malformed' });
    }
  });

  it('coalesces identical newest fallback candidates and rejects bucket conflicts', () => {
    const common = snapshot('2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z');
    expect(resolveQuotaWindowObservation(upstream({ a: common, aCopy: { ...common } }))).toEqual({
      status: 'ambiguous',
    });

    const fallbackA = { ...common };
    const fallbackB = { ...common };
    delete fallbackA.active_limit;
    delete fallbackB.active_limit;
    expect(resolveQuotaWindowObservation(upstream({ premium: fallbackA, ' Premium ': fallbackB }))).toMatchObject({
      status: 'valid',
    });
  });
});

describe('quota window transitions', () => {
  it('uses adaptive tolerance bounded from one second to five hours', () => {
    expect(quotaWindowToleranceMs(validObservation({ durationMs: 10_000 }), validObservation())).toBe(1_000);
    expect(quotaWindowToleranceMs(validObservation({ durationMs: 60 * 60_000 }), validObservation())).toBe(108_000);
    expect(quotaWindowToleranceMs(validObservation({ durationMs: 31 * 24 * 60 * 60_000 }), validObservation({ durationMs: 31 * 24 * 60 * 60_000 }))).toBe(5 * 60 * 60_000);
  });

  it('classifies stable, natural, manual, stale, regressive, and ambiguous updates', () => {
    const previous = observationAt('2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', '2026-07-01T00:30:00Z');
    expect(classifyQuotaWindowTransition(previous, observationAt(
      '2026-07-01T00:01:00Z',
      '2026-07-01T01:01:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('same');
    expect(classifyQuotaWindowTransition(previous, observationAt(
      '2026-07-01T01:00:00Z',
      '2026-07-01T02:00:00Z',
      '2026-07-01T01:01:00Z',
    ))).toBe('natural');
    expect(classifyQuotaWindowTransition(previous, observationAt(
      '2026-07-01T00:30:00Z',
      '2026-07-01T01:30:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('manual');
    expect(classifyQuotaWindowTransition(previous, observationAt(
      '2026-07-01T00:00:00Z',
      '2026-07-01T01:00:00Z',
      '2026-07-01T00:29:00Z',
    ))).toBe('stale');
    expect(classifyQuotaWindowTransition(previous, observationAt(
      '2026-06-30T23:00:00Z',
      '2026-07-01T00:00:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('regressive');
    expect(classifyQuotaWindowTransition(previous, observationAt(
      '2026-07-01T00:30:00Z',
      '2026-07-01T01:00:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('ambiguous');
  });

  it('treats provider slot relabeling as the same lifecycle identity', () => {
    const first = resolveQuotaWindowObservation(upstream({ plus: snapshot(
      '2026-07-01T01:00:00Z',
      '2026-07-08T00:00:00Z',
      {
        primary_window_minutes: 10_080,
        primary_used_percent: 70,
        secondary_window_minutes: 300,
        secondary_reset_after_at: '2026-07-01T05:00:00Z',
        secondary_used_percent: 10,
      },
    ) }));
    const relabeled = resolveQuotaWindowObservation(upstream({ plus: snapshot(
      '2026-07-01T01:01:00Z',
      '2026-07-01T05:00:00Z',
      {
        primary_window_minutes: 300,
        primary_used_percent: 10,
        secondary_window_minutes: 10_080,
        secondary_reset_after_at: '2026-07-08T00:00:00Z',
        secondary_used_percent: 70,
      },
    ) }));
    expect(first.status).toBe('valid');
    expect(relabeled.status).toBe('valid');
    if (first.status !== 'valid' || relabeled.status !== 'valid') return;

    expect(classifyQuotaWindowTransition(first.observation, relabeled.observation)).toBe('same');
    expect(matchesQuotaWindowCandidate(first.observation, relabeled.observation)).toBe(true);
  });

  it('rejects conflicting equal-observedAt transitions and pending-candidate matches', () => {
    const candidate = validObservation();
    const conflict = validObservation({
      endAt: '2026-07-01T01:01:00.000Z',
      endMs: Date.parse('2026-07-01T01:01:00.000Z'),
      usedPercent: 26,
    });
    expect(classifyQuotaWindowTransition(candidate, conflict)).toBe('ambiguous');
    expect(matchesQuotaWindowCandidate(candidate, conflict)).toBe(false);
  });

  it('matches later pending observations only within adaptive tolerance', () => {
    const candidate = validObservation();
    expect(matchesQuotaWindowCandidate(candidate, validObservation({
      observedAt: '2026-07-01T01:01:00.000Z',
      observedAtMs: Date.parse('2026-07-01T01:01:00.000Z'),
      startAt: '2026-07-01T00:01:00.000Z',
      startMs: Date.parse('2026-07-01T00:01:00.000Z'),
      endAt: '2026-07-01T01:01:00.000Z',
      endMs: Date.parse('2026-07-01T01:01:00.000Z'),
      usedPercent: 30,
    }))).toBe(true);
    expect(matchesQuotaWindowCandidate(candidate, validObservation({
      observedAt: '2026-07-01T01:01:00.000Z',
      observedAtMs: Date.parse('2026-07-01T01:01:00.000Z'),
      startAt: '2026-07-01T00:03:00.000Z',
      startMs: Date.parse('2026-07-01T00:03:00.000Z'),
      endAt: '2026-07-01T01:03:00.000Z',
      endMs: Date.parse('2026-07-01T01:03:00.000Z'),
    }))).toBe(false);
  });
});
