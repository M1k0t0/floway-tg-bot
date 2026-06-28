import type {
  BillingDimension,
  CodexQuotaSnapshot,
  FlowayAdminUser,
  ModelPricing,
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
  'output',
  'output_image',
];

export interface UsageWindow {
  label: 'Primary window' | 'Secondary window';
  startHour: string;
  endHour: string;
  startAt: string;
  endAt: string;
  upstreamPercent?: number;
}

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
  | 'observed_at'
  | 'primary_used_percent'
  | 'primary_window_minutes'
  | 'primary_reset_after_at'
  | 'secondary_used_percent'
  | 'secondary_window_minutes'
  | 'secondary_reset_after_at'
>;

export const unitPriceForDimension = (pricing: ModelPricing | null, dimension: BillingDimension): number | null => {
  if (!pricing) return null;
  switch (dimension) {
  case 'input':
    return pricing.input ?? null;
  case 'input_cache_read':
    return pricing.input_cache_read ?? pricing.input ?? null;
  case 'input_cache_write':
    return pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_cache_write_1h':
    return pricing.input_cache_write_1h ?? pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_image':
    return pricing.input_image ?? pricing.input ?? null;
  case 'output':
    return pricing.output ?? null;
  case 'output_image':
    return pricing.output_image ?? pricing.output ?? null;
  }
};

export const recordCostUsd = (record: UsageRecord): number => {
  let total = 0;
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0;
    const unitPrice = unitPriceForDimension(record.cost, dimension);
    if (tokens > 0 && unitPrice !== null) total += tokens * unitPrice;
  }
  return total / 1_000_000;
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
  for (const dimension of BILLING_DIMENSIONS) {
    const count = record.tokens[dimension] ?? 0;
    if (count > 0) totals.tokens[dimension] = (totals.tokens[dimension] ?? 0) + count;
  }
};

export const hourString = (date: Date): string => date.toISOString().slice(0, 13);

export const computeWindowsForUpstream = (upstream: Pick<UpstreamRecord, 'provider' | 'codex_quota'>): UsageWindow[] =>
  computeWindowsFromQuota(quotaWindowSnapshotForUpstream(upstream));

export const quotaWindowSnapshotForUpstream = (upstream: Pick<UpstreamRecord, 'provider' | 'codex_quota'>): WindowQuotaSnapshot | null => {
  switch (upstream.provider) {
  case 'codex':
    return upstream.codex_quota ?? null;
  default:
    return null;
  }
};

export const computeWindowsFromQuota = (quota: WindowQuotaSnapshot | null | undefined): UsageWindow[] => {
  if (!quota) return [];
  const windows: UsageWindow[] = [];
  const primary = quotaWindow('Primary window', quota.primary_window_minutes, quota.primary_reset_after_at, quota.primary_used_percent);
  if (primary) windows.push(primary);
  const secondary = quotaWindow('Secondary window', quota.secondary_window_minutes, quota.secondary_reset_after_at, quota.secondary_used_percent);
  if (secondary) windows.push(secondary);
  return windows;
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
  label: UsageWindow['label'],
  minutes: number | undefined,
  resetAt: string | undefined,
  upstreamPercent: number | undefined,
): UsageWindow | null => {
  if (!minutes || !resetAt) return null;
  const end = new Date(resetAt);
  if (!Number.isFinite(end.getTime())) return null;
  const start = new Date(end.getTime() - minutes * 60_000);
  return {
    label,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startHour: hourString(start),
    endHour: hourString(end),
    ...(upstreamPercent !== undefined ? { upstreamPercent } : {}),
  };
};
