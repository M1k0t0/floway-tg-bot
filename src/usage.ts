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
  label: 'Primary window';
  startHour: string;
  endHour: string;
  startAt: string;
  endAt: string;
  upstreamPercent?: number;
  quotaBucketKey?: string;
  quotaActiveLimit?: string;
}

export interface CodexQuotaBucket {
  key: string;
  snapshot: CodexQuotaSnapshot;
}

export const CODEX_QUOTA_ACTIVE_LIMIT = 'premium';

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
>;

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

const decimalStringToNumber = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative finite decimal string`);
  }
  return parsed;
};

export const recordCostUsd = (record: UsageRecord): number => {
  let total = 0;
  for (const row of record.metrics) {
    if (row.unitPrice === null) continue;
    const quantity = decimalStringToNumber(row.quantity, `${row.metric} quantity`);
    const unitPrice = decimalStringToNumber(row.unitPrice, `${row.metric} unit price`);
    total += quantity * unitPrice;
  }
  return total;
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
  if (upstream.kind !== 'codex' || !upstream.codex_quota) return [];
  return Object.entries(upstream.codex_quota)
    .filter(([key, snapshot]) => isPremiumCodexQuotaBucket(key, snapshot))
    .map(([key, snapshot]) => ({ key, snapshot }))
    .sort((a, b) => a.key.localeCompare(b.key));
};

const isPremiumCodexQuotaBucket = (key: string, snapshot: CodexQuotaSnapshot): boolean =>
  normalizeCodexQuotaActiveLimit(snapshot.active_limit) === CODEX_QUOTA_ACTIVE_LIMIT
  || normalizeCodexQuotaActiveLimit(key) === CODEX_QUOTA_ACTIVE_LIMIT;

const normalizeCodexQuotaActiveLimit = (value: string | undefined): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
};

export const selectPrimaryQuotaWindowForUpstream = (upstream: Pick<UpstreamRecord, 'kind' | 'codex_quota'>): UsageWindow | null => {
  for (const bucket of codexQuotaBucketsForUpstream(upstream)) {
    const window = buildPrimaryQuotaWindow(bucket.snapshot, bucket);
    if (window) return window;
  }
  return null;
};

export const buildPrimaryQuotaWindow = (
  quota: WindowQuotaSnapshot | null | undefined,
  bucket?: Pick<CodexQuotaBucket, 'key' | 'snapshot'>,
): UsageWindow | null => {
  if (!quota) return null;
  return quotaWindow(
    quota.primary_window_minutes,
    quota.primary_reset_after_at,
    quota.primary_used_percent,
    bucket,
  );
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

const quotaWindow = (
  minutes: number | undefined,
  resetAt: string | undefined,
  upstreamPercent: number | undefined,
  bucket?: Pick<CodexQuotaBucket, 'key' | 'snapshot'>,
): UsageWindow | null => {
  if (!minutes || !resetAt) return null;
  const end = new Date(resetAt);
  if (!Number.isFinite(end.getTime())) return null;
  const start = new Date(end.getTime() - minutes * 60_000);
  return {
    label: 'Primary window',
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startHour: hourString(start),
    endHour: hourString(end),
    ...(upstreamPercent !== undefined ? { upstreamPercent } : {}),
    ...(bucket ? { quotaBucketKey: bucket.key } : {}),
    ...(bucket?.snapshot.active_limit ? { quotaActiveLimit: bucket.snapshot.active_limit } : {}),
  };
};
