import {
  parseQuotaWindowObservation,
  CODEX_PREMIUM_ACTIVE_LIMIT,
  resolveQuotaWindowObservation,
  type QuotaWindowObservation,
} from './quota-window.js';
import type {
  BillingDimension,
  BillingMetric,
  CodexQuotaSnapshot,
  FlowayAdminUser,
  SanitizedExportSnapshot,
  TokenUsage,
  UpstreamRecord,
  UsageRecord,
} from './types.js';

export const BILLING_DIMENSIONS: readonly BillingDimension[] = [
  'input',
  'input_cache_read',
  'input_cache_write',
  'input_cache_write_1h',
  'input_image',
  'input_audio',
  'output',
  'output_image',
];

export interface UsageWindow {
  label: 'Quota window';
  startHour: string;
  endHour: string;
  startAt: string;
  endAt: string;
  observedAt?: string;
  observedAtMs?: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  upstreamPercent?: number;
  quotaBucketKey?: string;
  quotaActiveLimit?: string;
}

export interface CodexQuotaBucket {
  key: string;
  snapshot: CodexQuotaSnapshot;
}

export const CODEX_QUOTA_ACTIVE_LIMIT = CODEX_PREMIUM_ACTIVE_LIMIT;

export interface UsageWindowReport {
  window: UsageWindow;
  user: UsageTotals;
  upstream: UsageTotals;
  userTokenSharePercent: number | null;
  userRequestSharePercent: number | null;
}

export interface UsageTotals {
  requests: number;
  tokens: TokenUsage;
  cost: number;
}

export type LeaderboardDays = 1 | 7 | 30;

export interface UsageLeaderboardEntry {
  userId: number;
  username: string;
  totals: UsageTotals;
  cachePercent: number | null;
}

export interface UsageLeaderboardTotals {
  tokens: number;
  cost: number;
  cacheReadTokens: number;
}

export interface UsageLeaderboardReport {
  days: LeaderboardDays;
  startAt: string;
  endAt: string;
  exportedAt: string;
  totals: UsageLeaderboardTotals;
  byTokens: UsageLeaderboardEntry[];
  byCost: UsageLeaderboardEntry[];
  byCachePercent: UsageLeaderboardEntry[];
}

export interface UsageQuotaEstimate {
  window: UsageWindow;
  upstreamUsedPercent: number;
  user: UsageTotals;
  upstream: UsageTotals;
  userTokenSharePercent: number | null;
  userUpstreamQuotaSharePercent: number | null;
  nonAdminUserCount: number;
  equalSharePercent: number | null;
  estimatedUserUsedPercent: number | null;
}

type WindowQuotaSnapshot = Pick<
  CodexQuotaSnapshot,
  | 'primary_used_percent'
  | 'primary_window_minutes'
  | 'primary_reset_after_at'
> & Partial<Pick<
  CodexQuotaSnapshot,
  | 'observed_at'
  | 'active_limit'
>>;

const TOKEN_DIMENSION_BY_METRIC: Partial<Record<BillingMetric, BillingDimension>> = {
  input_tokens: 'input',
  input_cache_read_tokens: 'input_cache_read',
  input_cache_write_tokens: 'input_cache_write',
  input_cache_write_1h_tokens: 'input_cache_write_1h',
  input_image_tokens: 'input_image',
  input_audio_tokens: 'input_audio',
  output_tokens: 'output',
  output_image_tokens: 'output_image',
};

interface FixedDecimal {
  coefficient: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^(\d+)(?:[.](\d+))?$/;

const parseDecimalString = (value: string, label: string): FixedDecimal => {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new TypeError(`${label} must be a non-negative finite decimal string`);
  return {
    coefficient: BigInt(`${match[1]}${match[2] ?? ''}`),
    scale: match[2]?.length ?? 0,
  };
};

const decimalStringToNumber = (value: string, label: string): number => {
  parseDecimalString(value, label);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} exceeds the supported numeric range`);
  return parsed;
};

const addFixedDecimals = (left: FixedDecimal, right: FixedDecimal): FixedDecimal => {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: left.coefficient * (10n ** BigInt(scale - left.scale))
      + right.coefficient * (10n ** BigInt(scale - right.scale)),
    scale,
  };
};

const fixedDecimalToNumber = ({ coefficient, scale }: FixedDecimal): number => {
  let digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale > 0) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) throw new RangeError('usage cost exceeds the supported numeric range');
  return parsed;
};

export const recordCostUsd = (record: UsageRecord): number => {
  let total: FixedDecimal = { coefficient: 0n, scale: 0 };
  for (const row of record.metrics) {
    if (row.unitPrice === null) continue;
    const quantity = parseDecimalString(row.quantity, `${row.metric} quantity`);
    const unitPrice = parseDecimalString(row.unitPrice, `${row.metric} unit price`);
    total = addFixedDecimals(total, {
      coefficient: quantity.coefficient * unitPrice.coefficient,
      scale: quantity.scale + unitPrice.scale,
    });
  }
  return fixedDecimalToNumber(total);
};

export const tokenTotal = (tokens: TokenUsage): number =>
  BILLING_DIMENSIONS.reduce((sum, dimension) => sum + (tokens[dimension] ?? 0), 0);

export const cacheReadPercent = (tokens: TokenUsage): number | null => {
  const cacheRead = tokens.input_cache_read ?? 0;
  const inputTokens = (tokens.input ?? 0)
    + cacheRead
    + (tokens.input_cache_write ?? 0)
    + (tokens.input_cache_write_1h ?? 0);
  return inputTokens > 0 ? (cacheRead / inputTokens) * 100 : null;
};

export const emptyTotals = (): UsageTotals => ({ requests: 0, tokens: {}, cost: 0 });

export const addUsageRecord = (totals: UsageTotals, record: UsageRecord): void => {
  totals.requests += record.requests;
  totals.cost += recordCostUsd(record);
  for (const row of record.metrics) {
    const dimension = TOKEN_DIMENSION_BY_METRIC[row.metric];
    if (!dimension) continue;
    const count = decimalStringToNumber(row.quantity, `${row.metric} quantity`);
    if (count > 0) totals.tokens[dimension] = (totals.tokens[dimension] ?? 0) + count;
  }
};

export const hourString = (date: Date): string => date.toISOString().slice(0, 13);

export const codexQuotaBucketsForUpstream = (upstream: Pick<UpstreamRecord, 'kind' | 'codex_quota'>): CodexQuotaBucket[] => {
  if (upstream.kind !== 'codex' || !isQuotaSnapshotMap(upstream.codex_quota)) return [];
  const entries = Object.entries(upstream.codex_quota);
  const explicit = entries.filter(([, snapshot]) =>
    normalizeCodexQuotaActiveLimit(snapshot?.active_limit) === CODEX_QUOTA_ACTIVE_LIMIT);
  const eligible = explicit.length > 0
    ? explicit
    : entries.filter(([key, snapshot]) =>
      snapshot?.active_limit === undefined
      && normalizeCodexQuotaActiveLimit(key) === CODEX_QUOTA_ACTIVE_LIMIT);
  return eligible
    .filter((entry): entry is [string, CodexQuotaSnapshot] => isQuotaSnapshot(entry[1]))
    .map(([key, snapshot]) => ({ key, snapshot }))
    .sort((a, b) => a.key.localeCompare(b.key));
};

const normalizeCodexQuotaActiveLimit = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

export const selectQuotaWindowForUpstream = (upstream: Pick<UpstreamRecord, 'id' | 'kind' | 'codex_quota'>): UsageWindow | null => {
  const resolution = resolveQuotaWindowObservation(upstream as UpstreamRecord);
  return resolution.status === 'valid' ? quotaObservationToUsageWindow(resolution.observation) : null;
};

export const quotaObservationToUsageWindow = (observation: QuotaWindowObservation): UsageWindow => {
  const start = new Date(observation.startMs);
  const end = new Date(observation.endMs);
  return {
    label: 'Quota window',
    startAt: observation.startAt,
    endAt: observation.endAt,
    startHour: hourString(start),
    endHour: hourString(end),
    observedAt: observation.observedAt,
    observedAtMs: observation.observedAtMs,
    startMs: observation.startMs,
    endMs: observation.endMs,
    durationMs: observation.durationMs,
    ...(observation.usedPercent !== null ? { upstreamPercent: observation.usedPercent } : {}),
    quotaBucketKey: observation.bucketKey,
    quotaActiveLimit: observation.activeLimit,
  };
};

export const buildQuotaWindow = (
  quota: WindowQuotaSnapshot | null | undefined,
  bucket?: Pick<CodexQuotaBucket, 'key' | 'snapshot'>,
): UsageWindow | null => {
  if (!quota) return null;
  const observation = parseQuotaWindowObservation(
    'legacy',
    bucket?.key ?? CODEX_QUOTA_ACTIVE_LIMIT,
    {
      ...quota,
      active_limit: quota.active_limit ?? bucket?.snapshot.active_limit,
    },
  );
  return observation ? quotaObservationToUsageWindow(observation) : null;
};

export const summarizeUsageWindow = (
  flowayUserId: number,
  upstreamId: string,
  window: UsageWindow,
  snapshot: SanitizedExportSnapshot,
): UsageWindowReport => {
  const userKeyIds = new Set(snapshot.apiKeys.filter(key => key.userId === flowayUserId).map(key => key.id));
  const user = emptyTotals();
  const upstream = emptyTotals();

  for (const record of snapshot.usage) {
    if (record.upstream !== upstreamId) continue;
    if (record.hour < window.startHour || record.hour >= window.endHour) continue;
    addUsageRecord(upstream, record);
    if (userKeyIds.has(record.keyId)) addUsageRecord(user, record);
  }

  const upstreamTokens = tokenTotal(upstream.tokens);
  const userTokens = tokenTotal(user.tokens);
  return {
    window,
    user,
    upstream,
    userTokenSharePercent: upstreamTokens > 0 ? (userTokens / upstreamTokens) * 100 : null,
    userRequestSharePercent: upstream.requests > 0 ? (user.requests / upstream.requests) * 100 : null,
  };
};

export const summarizeUsageLeaderboard = (
  snapshot: SanitizedExportSnapshot,
  days: LeaderboardDays = 7,
  limit = 4,
  now = new Date(),
  upstreamIds: readonly string[] | null = null,
): UsageLeaderboardReport => {
  const exportedAt = validDateOrFallback(snapshot.exportedAt, now);
  const startAt = new Date(exportedAt.getTime() - days * 24 * 60 * 60 * 1000);
  const startHour = hourString(startAt);
  const endHour = hourString(new Date(exportedAt.getTime() + 60 * 60 * 1000));
  const usersById = new Map(snapshot.users.map(user => [user.id, user]));
  const userIdByKey = new Map(snapshot.apiKeys.map(key => [key.id, key.userId]));
  const entries = new Map<number, UsageLeaderboardEntry>();
  const allowedUpstreams = upstreamIds === null ? null : new Set(upstreamIds);

  for (const record of snapshot.usage) {
    if (allowedUpstreams && (!record.upstream || !allowedUpstreams.has(record.upstream))) continue;
    if (record.hour < startHour || record.hour >= endHour) continue;
    const userId = userIdByKey.get(record.keyId);
    if (userId === undefined) continue;
    const user = usersById.get(userId);
    let entry = entries.get(userId);
    if (!entry) {
      entry = {
        userId,
        username: user?.username ?? `user:${userId}`,
        totals: emptyTotals(),
        cachePercent: null,
      };
      entries.set(userId, entry);
    }
    addUsageRecord(entry.totals, record);
  }

  const all = [...entries.values()].map(entry => ({
    ...entry,
    cachePercent: cacheReadPercent(entry.totals.tokens),
  }));
  const totals: UsageLeaderboardTotals = {
    tokens: all.reduce((sum, entry) => sum + tokenTotal(entry.totals.tokens), 0),
    cost: all.reduce((sum, entry) => sum + entry.totals.cost, 0),
    cacheReadTokens: all.reduce((sum, entry) => sum + (entry.totals.tokens.input_cache_read ?? 0), 0),
  };

  return {
    days,
    startAt: startAt.toISOString(),
    endAt: exportedAt.toISOString(),
    exportedAt: snapshot.exportedAt,
    totals,
    byTokens: all.slice().sort(compareByTokens).slice(0, limit),
    byCost: all.slice().sort(compareByCost).slice(0, limit),
    byCachePercent: all.slice().sort(compareByCachePercent).slice(0, limit),
  };
};

export const summarizeUsageQuotaEstimate = (
  flowayUserId: number,
  upstreamId: string,
  window: UsageWindow,
  upstreamUsedPercent: number,
  snapshot: SanitizedExportSnapshot,
  nonAdminUserCount: number,
): UsageQuotaEstimate => {
  const userKeyIds = new Set(snapshot.apiKeys.filter(key => key.userId === flowayUserId).map(key => key.id));
  const user = emptyTotals();
  const upstream = emptyTotals();

  for (const record of snapshot.usage) {
    if (record.upstream !== upstreamId) continue;
    if (record.hour < window.startHour || record.hour >= window.endHour) continue;
    addUsageRecord(upstream, record);
    if (userKeyIds.has(record.keyId)) addUsageRecord(user, record);
  }

  const upstreamTokens = tokenTotal(upstream.tokens);
  const userTokens = tokenTotal(user.tokens);
  const userTokenSharePercent = upstreamTokens > 0 ? (userTokens / upstreamTokens) * 100 : null;
  const userUpstreamQuotaSharePercent = userTokenSharePercent !== null
    ? (userTokenSharePercent / 100) * upstreamUsedPercent
    : null;
  const equalSharePercent = nonAdminUserCount > 0 ? 100 / nonAdminUserCount : null;
  const estimatedUserUsedPercent = userUpstreamQuotaSharePercent !== null && equalSharePercent !== null
    ? (userUpstreamQuotaSharePercent / equalSharePercent) * 100
    : null;

  return {
    window,
    upstreamUsedPercent,
    user,
    upstream,
    userTokenSharePercent,
    userUpstreamQuotaSharePercent,
    nonAdminUserCount,
    equalSharePercent,
    estimatedUserUsedPercent,
  };
};

export const canShareUpstreamQuota = (user: Pick<FlowayAdminUser, 'isAdmin' | 'upstreamIds'>, upstreamId: string): boolean =>
  !user.isAdmin && (user.upstreamIds === null || user.upstreamIds.includes(upstreamId));

const compareByTokens = (a: UsageLeaderboardEntry, b: UsageLeaderboardEntry): number =>
  tokenTotal(b.totals.tokens) - tokenTotal(a.totals.tokens)
  || b.totals.cost - a.totals.cost
  || a.username.localeCompare(b.username);

const compareByCost = (a: UsageLeaderboardEntry, b: UsageLeaderboardEntry): number =>
  b.totals.cost - a.totals.cost
  || tokenTotal(b.totals.tokens) - tokenTotal(a.totals.tokens)
  || a.username.localeCompare(b.username);

const compareByCachePercent = (a: UsageLeaderboardEntry, b: UsageLeaderboardEntry): number =>
  (b.cachePercent ?? -1) - (a.cachePercent ?? -1)
  || tokenTotal(b.totals.tokens) - tokenTotal(a.totals.tokens)
  || a.username.localeCompare(b.username);

const validDateOrFallback = (value: string, fallback: Date): Date => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
};

const isQuotaSnapshotMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isQuotaSnapshot = (value: unknown): value is CodexQuotaSnapshot =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
