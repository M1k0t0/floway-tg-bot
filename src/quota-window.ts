import type { UpstreamRecord } from './types.js';

export const CODEX_PREMIUM_ACTIVE_LIMIT = 'premium';

const MAX_WINDOW_MINUTES = 31 * 24 * 60;
const MIN_TOLERANCE_MS = 1_000;
const MAX_TOLERANCE_MS = 5 * 60 * 60 * 1_000;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.](\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface QuotaWindowObservation {
  upstreamId: string;
  bucketKey: string;
  activeLimit: typeof CODEX_PREMIUM_ACTIVE_LIMIT;
  observedAt: string;
  observedAtMs: number;
  startAt: string;
  startMs: number;
  endAt: string;
  endMs: number;
  durationMs: number;
  usedPercent: number | null;
}

export type QuotaWindowResolution =
  | { status: 'valid'; observation: QuotaWindowObservation }
  | { status: 'missing' }
  | { status: 'unsupported' }
  | { status: 'malformed' }
  | { status: 'ambiguous' };

export type QuotaWindowTransition =
  | 'same'
  | 'natural'
  | 'manual'
  | 'stale'
  | 'regressive'
  | 'ambiguous';

type CandidateKind = 'explicit' | 'fallback';
type ProviderWindowSlot = 'primary' | 'secondary';

interface ParsedWindowFacts {
  startAt: string;
  startMs: number;
  endAt: string;
  endMs: number;
  durationMs: number;
  usedPercent: number | null;
}

type ParsedWindowSlot =
  | { status: 'absent' }
  | { status: 'malformed' }
  | { status: 'valid'; facts: ParsedWindowFacts };

type ParsedCandidate =
  | { status: 'valid'; observation: QuotaWindowObservation; observedAtMs: number }
  | { status: 'malformed' | 'ambiguous'; observedAtMs: number | null };

interface QuotaCandidate {
  bucketKey: string;
  snapshot: unknown;
}

export const resolveQuotaWindowObservation = (upstream: UpstreamRecord): QuotaWindowResolution => {
  try {
    if (!isRecord(upstream) || upstream.kind !== 'codex') return { status: 'unsupported' };
    if (typeof upstream.id !== 'string' || upstream.id.length === 0) return { status: 'malformed' };

    const quota: unknown = upstream.codex_quota;
    if (quota === null || quota === undefined) return { status: 'missing' };
    if (!isRecord(quota)) {
      if (Array.isArray(quota) && quota.length === 0) return { status: 'missing' };
      return { status: 'malformed' };
    }

    const entries = Object.entries(quota);
    if (entries.length === 0) return { status: 'missing' };

    const explicit: QuotaCandidate[] = [];
    const fallback: QuotaCandidate[] = [];
    for (const [bucketKey, snapshot] of entries) {
      const kind = premiumQuotaCandidateKind(bucketKey, snapshot);
      if (kind === 'explicit') explicit.push({ bucketKey, snapshot });
      if (kind === 'fallback') fallback.push({ bucketKey, snapshot });
    }

    const candidates = explicit.length > 0 ? explicit : fallback;
    if (candidates.length === 0) return { status: 'missing' };
    return resolveCandidates(upstream.id, candidates);
  } catch {
    return { status: 'malformed' };
  }
};

export const parseQuotaWindowObservation = (
  upstreamId: string,
  bucketKey: string,
  snapshot: unknown,
): QuotaWindowObservation | null => {
  if (premiumQuotaCandidateKind(bucketKey, snapshot) === null) return null;
  const parsed = parseCandidate(upstreamId, bucketKey, snapshot);
  return parsed.status === 'valid' ? parsed.observation : null;
};

export const quotaWindowToleranceMs = (
  left: Pick<QuotaWindowObservation, 'durationMs'>,
  right: Pick<QuotaWindowObservation, 'durationMs'>,
): number => Math.min(
  MAX_TOLERANCE_MS,
  Math.max(MIN_TOLERANCE_MS, Math.min(left.durationMs, right.durationMs) * 0.03),
);

export const classifyQuotaWindowTransition = (
  previous: QuotaWindowObservation,
  current: QuotaWindowObservation,
): QuotaWindowTransition => {
  if (previous.upstreamId !== current.upstreamId) return 'ambiguous';
  if (current.observedAtMs < previous.observedAtMs) return 'stale';
  if (
    current.observedAtMs === previous.observedAtMs
    && !sameNormalizedObservation(previous, current)
  ) {
    return 'ambiguous';
  }

  const tolerance = quotaWindowToleranceMs(previous, current);
  const sameStart = Math.abs(current.startMs - previous.startMs) <= tolerance;
  const sameEnd = Math.abs(current.endMs - previous.endMs) <= tolerance;
  if (sameStart && sameEnd) return 'same';

  const startAdvanced = current.startMs > previous.startMs + tolerance;
  const endAdvanced = current.endMs > previous.endMs + tolerance;
  if (
    startAdvanced
    && endAdvanced
    && current.startMs >= previous.endMs - tolerance
  ) {
    return 'natural';
  }
  if (
    current.startMs > previous.startMs + tolerance
    && current.startMs < previous.endMs - tolerance
    && current.endMs > previous.endMs + tolerance
  ) {
    return 'manual';
  }
  if (
    current.startMs < previous.startMs - tolerance
    || current.endMs < previous.endMs - tolerance
  ) {
    return 'regressive';
  }
  return 'ambiguous';
};

export const matchesQuotaWindowCandidate = (
  candidate: QuotaWindowObservation,
  observation: QuotaWindowObservation,
): boolean => {
  if (
    candidate.upstreamId !== observation.upstreamId
    || candidate.bucketKey !== observation.bucketKey
    || candidate.activeLimit !== observation.activeLimit
    || observation.observedAtMs < candidate.observedAtMs
  ) {
    return false;
  }
  if (observation.observedAtMs === candidate.observedAtMs) {
    return sameNormalizedObservation(candidate, observation);
  }

  const tolerance = quotaWindowToleranceMs(candidate, observation);
  return Math.abs(candidate.startMs - observation.startMs) <= tolerance
    && Math.abs(candidate.endMs - observation.endMs) <= tolerance;
};

const resolveCandidates = (
  upstreamId: string,
  candidates: readonly QuotaCandidate[],
): QuotaWindowResolution => {
  const parsed = candidates
    .slice()
    .sort((left, right) => left.bucketKey.localeCompare(right.bucketKey))
    .map(candidate => parseCandidate(upstreamId, candidate.bucketKey, candidate.snapshot));
  if (parsed.some(candidate => candidate.observedAtMs === null)) return { status: 'malformed' };

  const newestObservedAtMs = Math.max(...parsed.map(candidate => candidate.observedAtMs as number));
  const newest = parsed.filter(candidate => candidate.observedAtMs === newestObservedAtMs);
  if (newest.some(candidate => candidate.status === 'malformed')) return { status: 'malformed' };
  if (newest.some(candidate => candidate.status === 'ambiguous')) return { status: 'ambiguous' };

  const valid = newest.filter((candidate): candidate is Extract<ParsedCandidate, { status: 'valid' }> =>
    candidate.status === 'valid');
  if (valid.length === 0) return { status: 'malformed' };
  const observation = valid[0]!.observation;
  if (!valid.every(candidate => sameNormalizedObservation(observation, candidate.observation))) {
    return { status: 'ambiguous' };
  }
  return { status: 'valid', observation };
};

const parseCandidate = (
  upstreamId: string,
  bucketKey: string,
  snapshot: unknown,
): ParsedCandidate => {
  if (!isRecord(snapshot)) return { status: 'malformed', observedAtMs: null };

  const observed = parseRfc3339(snapshot.observed_at);
  const observedAtMs = observed?.ms ?? null;
  const normalizedBucketKey = normalizeName(bucketKey);
  if (observed === null || normalizedBucketKey === null) {
    return { status: 'malformed', observedAtMs };
  }

  const slots = [
    parseWindowSlot(snapshot, 'primary'),
    parseWindowSlot(snapshot, 'secondary'),
  ];
  if (slots.some(slot => slot.status === 'malformed')) {
    return { status: 'malformed', observedAtMs };
  }

  const valid = slots.filter((slot): slot is Extract<ParsedWindowSlot, { status: 'valid' }> =>
    slot.status === 'valid');
  if (valid.length === 0) return { status: 'malformed', observedAtMs };

  const latestEndMs = Math.max(...valid.map(slot => slot.facts.endMs));
  const latest = valid.filter(slot => slot.facts.endMs === latestEndMs);
  const longestDurationMs = Math.max(...latest.map(slot => slot.facts.durationMs));
  const selected = latest.filter(slot => slot.facts.durationMs === longestDurationMs);
  const facts = selected[0]!.facts;
  if (!selected.every(slot => sameWindowFacts(facts, slot.facts))) {
    return { status: 'ambiguous', observedAtMs };
  }

  return {
    status: 'valid',
    observedAtMs: observed.ms,
    observation: {
      upstreamId,
      bucketKey: normalizedBucketKey,
      activeLimit: CODEX_PREMIUM_ACTIVE_LIMIT,
      observedAt: observed.iso,
      observedAtMs: observed.ms,
      ...facts,
    },
  };
};

const parseWindowSlot = (
  snapshot: Record<string, unknown>,
  slot: ProviderWindowSlot,
): ParsedWindowSlot => {
  const minutes = snapshot[`${slot}_window_minutes`];
  const resetAt = snapshot[`${slot}_reset_after_at`];
  const usedPercent = snapshot[`${slot}_used_percent`];
  if (minutes === undefined && resetAt === undefined && usedPercent === undefined) {
    return { status: 'absent' };
  }

  const end = parseRfc3339(resetAt);
  if (
    !Number.isSafeInteger(minutes)
    || (minutes as number) <= 0
    || (minutes as number) > MAX_WINDOW_MINUTES
    || end === null
    || !validUsedPercent(usedPercent)
  ) {
    return { status: 'malformed' };
  }

  const durationMs = (minutes as number) * 60_000;
  const startMs = end.ms - durationMs;
  if (!Number.isFinite(startMs) || startMs >= end.ms) return { status: 'malformed' };

  return {
    status: 'valid',
    facts: {
      startAt: new Date(startMs).toISOString(),
      startMs,
      endAt: end.iso,
      endMs: end.ms,
      durationMs,
      usedPercent: usedPercent === undefined ? null : usedPercent as number,
    },
  };
};

const premiumQuotaCandidateKind = (bucketKey: string, snapshot: unknown): CandidateKind | null => {
  if (!isRecord(snapshot)) {
    return normalizeName(bucketKey) === CODEX_PREMIUM_ACTIVE_LIMIT ? 'fallback' : null;
  }
  if (snapshot.active_limit !== undefined) {
    return normalizeName(snapshot.active_limit) === CODEX_PREMIUM_ACTIVE_LIMIT ? 'explicit' : null;
  }
  return normalizeName(bucketKey) === CODEX_PREMIUM_ACTIVE_LIMIT ? 'fallback' : null;
};

const validUsedPercent = (value: unknown): boolean =>
  value === undefined
  || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);

const sameWindowFacts = (
  left: ParsedWindowFacts,
  right: ParsedWindowFacts,
): boolean =>
  left.startAt === right.startAt
  && left.startMs === right.startMs
  && left.endAt === right.endAt
  && left.endMs === right.endMs
  && left.durationMs === right.durationMs
  && Object.is(left.usedPercent, right.usedPercent);

const sameNormalizedObservation = (
  left: QuotaWindowObservation,
  right: QuotaWindowObservation,
): boolean =>
  left.upstreamId === right.upstreamId
  && left.bucketKey === right.bucketKey
  && left.activeLimit === right.activeLimit
  && left.observedAt === right.observedAt
  && left.observedAtMs === right.observedAtMs
  && sameWindowFacts(left, right);

const normalizeName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseRfc3339 = (value: unknown): { iso: string; ms: number } | null => {
  if (typeof value !== 'string') return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null;
  }

  const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
    || local.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  const offsetSign = match[9] === '-' ? -1 : 1;
  const offsetMs = match[8] === 'Z'
    ? 0
    : offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const ms = local.getTime() - offsetMs;
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? { iso, ms } : null;
};

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
