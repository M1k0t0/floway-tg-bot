import { describe, expect, it } from 'vitest';

import {
  classifyPrimaryQuotaTransition,
  matchesPrimaryQuotaCandidate,
  primaryQuotaToleranceMs,
  resolvePrimaryQuotaObservation,
  type PrimaryQuotaObservation,
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

const validObservation = (overrides: Partial<PrimaryQuotaObservation> = {}): PrimaryQuotaObservation => ({
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
  overrides: Partial<PrimaryQuotaObservation> = {},
): PrimaryQuotaObservation => validObservation({
  observedAt,
  observedAtMs: Date.parse(observedAt),
  startAt,
  startMs: Date.parse(startAt),
  endAt,
  endMs: Date.parse(endAt),
  durationMs: Date.parse(endAt) - Date.parse(startAt),
  ...overrides,
});

describe('resolvePrimaryQuotaObservation', () => {
  it('returns unsupported and missing without manufacturing observations', () => {
    expect(resolvePrimaryQuotaObservation(upstream(null, 'copilot'))).toEqual({ status: 'unsupported' });
    expect(resolvePrimaryQuotaObservation(upstream(null))).toEqual({ status: 'missing' });
    expect(resolvePrimaryQuotaObservation(upstream({}))).toEqual({ status: 'missing' });
    expect(resolvePrimaryQuotaObservation(upstream({ enterprise: snapshot(
      '2026-07-01T01:00:00Z',
      '2026-07-01T02:00:00Z',
      { active_limit: 'enterprise' },
    ) }))).toEqual({ status: 'missing' });
  });

  it('normalizes explicit-offset timestamps and preserves observed time', () => {
    const quota = snapshot(
      '2026-07-01T03:04:05.125+02:00',
      '2026-07-01T04:00:00+02:00',
      { active_limit: ' Premium ', primary_window_minutes: 90 },
    );
    delete quota.primary_used_percent;
    const result = resolvePrimaryQuotaObservation(upstream({ plus: quota }));

    expect(result).toEqual({
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

  it('uses the premium key only when active_limit is absent', () => {
    const fallback = snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z');
    delete fallback.active_limit;
    expect(resolvePrimaryQuotaObservation(upstream({ ' Premium ': fallback }))).toMatchObject({
      status: 'valid',
      observation: { bucketKey: 'premium', activeLimit: 'premium' },
    });
    expect(resolvePrimaryQuotaObservation(upstream({ premium: {
      ...fallback,
      active_limit: 'enterprise',
    } }))).toEqual({ status: 'missing' });
  });

  it('gives explicit premium candidates precedence over fallback candidates', () => {
    const fallback = snapshot('2026-07-01T03:00:00Z', '2026-07-01T04:00:00Z');
    delete fallback.active_limit;
    const result = resolvePrimaryQuotaObservation(upstream({
      premium: fallback,
      plus: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'),
    }));

    expect(result).toMatchObject({
      status: 'valid',
      observation: { bucketKey: 'plus', endAt: '2026-07-01T02:00:00.000Z' },
    });
  });

  it('validates runtime bucket values without throwing', () => {
    const malformed: unknown[] = [
      { premium: null },
      { premium: [] },
      { premium: snapshot('not-a-date', '2026-07-01T02:00:00Z') },
      { premium: snapshot('2026-07-01 01:00:00', '2026-07-01T02:00:00Z') },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-02-30T02:00:00Z') },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00') },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_window_minutes: 0 }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_window_minutes: 1.5 }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_window_minutes: 44641 }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_used_percent: Number.NaN }) },
      { premium: snapshot('2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z', { primary_used_percent: 101 }) },
    ];

    for (const quota of malformed) {
      expect(() => resolvePrimaryQuotaObservation(upstream(quota))).not.toThrow();
      expect(resolvePrimaryQuotaObservation(upstream(quota))).toEqual({ status: 'malformed' });
    }
  });

  it('selects the newest valid explicit candidate and lets it supersede older malformed data', () => {
    const result = resolvePrimaryQuotaObservation(upstream({
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
      const result = resolvePrimaryQuotaObservation(upstream({
        valid: snapshot('2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z'),
        broken: snapshot(observedAt, 'bad'),
      }));
      expect(result).toEqual({ status: 'malformed' });
    }
  });

  it('coalesces identical newest candidates and rejects equal-time conflicts', () => {
    const common = snapshot('2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z');
    expect(resolvePrimaryQuotaObservation(upstream({ a: common, aCopy: { ...common } }))).toMatchObject({
      status: 'valid',
    });

    const fallbackA = { ...common };
    const fallbackB = { ...common };
    delete fallbackA.active_limit;
    delete fallbackB.active_limit;
    expect(resolvePrimaryQuotaObservation(upstream({ premium: fallbackA, ' Premium ': fallbackB }))).toMatchObject({
      status: 'valid',
    });

    expect(resolvePrimaryQuotaObservation(upstream({
      a: common,
      b: { ...common, primary_used_percent: 26 },
    }))).toEqual({ status: 'ambiguous' });
  });
});

describe('primary quota transitions', () => {
  it('uses adaptive tolerance bounded from one second to five hours', () => {
    expect(primaryQuotaToleranceMs(validObservation({ durationMs: 10_000 }), validObservation())).toBe(1_000);
    expect(primaryQuotaToleranceMs(validObservation({ durationMs: 60 * 60_000 }), validObservation())).toBe(108_000);
    expect(primaryQuotaToleranceMs(validObservation({ durationMs: 31 * 24 * 60 * 60_000 }), validObservation({ durationMs: 31 * 24 * 60 * 60_000 }))).toBe(5 * 60 * 60_000);
  });

  it('classifies stable, natural, manual, stale, regressive, and ambiguous updates', () => {
    const previous = observationAt('2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z', '2026-07-01T00:30:00Z');
    expect(classifyPrimaryQuotaTransition(previous, observationAt(
      '2026-07-01T00:01:00Z',
      '2026-07-01T01:01:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('same');
    expect(classifyPrimaryQuotaTransition(previous, observationAt(
      '2026-07-01T01:00:00Z',
      '2026-07-01T02:00:00Z',
      '2026-07-01T01:01:00Z',
    ))).toBe('natural');
    expect(classifyPrimaryQuotaTransition(previous, observationAt(
      '2026-07-01T00:30:00Z',
      '2026-07-01T01:30:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('manual');
    expect(classifyPrimaryQuotaTransition(previous, observationAt(
      '2026-07-01T00:00:00Z',
      '2026-07-01T01:00:00Z',
      '2026-07-01T00:29:00Z',
    ))).toBe('stale');
    expect(classifyPrimaryQuotaTransition(previous, observationAt(
      '2026-06-30T23:00:00Z',
      '2026-07-01T00:00:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('regressive');
    expect(classifyPrimaryQuotaTransition(previous, observationAt(
      '2026-07-01T00:30:00Z',
      '2026-07-01T01:00:00Z',
      '2026-07-01T00:31:00Z',
    ))).toBe('ambiguous');
  });

  it('rejects conflicting equal-observedAt transitions and pending-candidate matches', () => {
    const candidate = validObservation();
    const conflict = validObservation({
      endAt: '2026-07-01T01:01:00.000Z',
      endMs: Date.parse('2026-07-01T01:01:00.000Z'),
      usedPercent: 26,
    });
    expect(classifyPrimaryQuotaTransition(candidate, conflict)).toBe('ambiguous');
    expect(matchesPrimaryQuotaCandidate(candidate, conflict)).toBe(false);
  });

  it('matches later pending observations only within adaptive tolerance', () => {
    const candidate = validObservation();
    expect(matchesPrimaryQuotaCandidate(candidate, validObservation({
      observedAt: '2026-07-01T01:01:00.000Z',
      observedAtMs: Date.parse('2026-07-01T01:01:00.000Z'),
      startAt: '2026-07-01T00:01:00.000Z',
      startMs: Date.parse('2026-07-01T00:01:00.000Z'),
      endAt: '2026-07-01T01:01:00.000Z',
      endMs: Date.parse('2026-07-01T01:01:00.000Z'),
      usedPercent: 30,
    }))).toBe(true);
    expect(matchesPrimaryQuotaCandidate(candidate, validObservation({
      observedAt: '2026-07-01T01:01:00.000Z',
      observedAtMs: Date.parse('2026-07-01T01:01:00.000Z'),
      startAt: '2026-07-01T00:03:00.000Z',
      startMs: Date.parse('2026-07-01T00:03:00.000Z'),
      endAt: '2026-07-01T01:03:00.000Z',
      endMs: Date.parse('2026-07-01T01:03:00.000Z'),
    }))).toBe(false);
  });
});
