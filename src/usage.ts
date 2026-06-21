import type {
  BillingDimension,
  CodexQuotaSnapshot,
  DisplayUsageRecord,
  ModelPricing,
  SanitizedExportSnapshot,
  TokenUsage,
  TokenUsageResponse,
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
  authoritativeUserCost: number;
}

export interface UsageTotals {
  requests: number;
  tokens: TokenUsage;
  cost: number;
}

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

export const emptyTotals = (): UsageTotals => ({ requests: 0, tokens: {}, cost: 0 });

export const addUsageRecord = (totals: UsageTotals, record: UsageRecord): void => {
  totals.requests += record.requests;
  totals.cost += recordCostUsd(record);
  for (const dimension of BILLING_DIMENSIONS) {
    const count = record.tokens[dimension] ?? 0;
    if (count > 0) totals.tokens[dimension] = (totals.tokens[dimension] ?? 0) + count;
  }
};

export const addDisplayUsageRecord = (totals: UsageTotals, record: DisplayUsageRecord): void => {
  totals.requests += record.requests;
  totals.cost += record.cost;
  for (const dimension of BILLING_DIMENSIONS) {
    const count = record.tokens[dimension] ?? 0;
    if (count > 0) totals.tokens[dimension] = (totals.tokens[dimension] ?? 0) + count;
  }
};

export const hourString = (date: Date): string => date.toISOString().slice(0, 13);

export const computeWindowsFromQuota = (quota: CodexQuotaSnapshot | null | undefined): UsageWindow[] => {
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
  userUsage: TokenUsageResponse,
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

  const authoritativeUser = emptyTotals();
  for (const record of userUsage.records) {
    if (record.hour < window.startHour || record.hour >= window.endHour) continue;
    addDisplayUsageRecord(authoritativeUser, record);
  }

  const upstreamTokens = tokenTotal(upstream.tokens);
  const userTokens = tokenTotal(user.tokens);
  return {
    window,
    user,
    upstream,
    authoritativeUserCost: authoritativeUser.cost,
    userTokenSharePercent: upstreamTokens > 0 ? (userTokens / upstreamTokens) * 100 : null,
    userRequestSharePercent: upstream.requests > 0 ? (user.requests / upstream.requests) * 100 : null,
  };
};

export const maxWindowRange = (windows: readonly UsageWindow[]): { start: string; end: string } | null => {
  if (windows.length === 0) return null;
  return {
    start: windows.reduce((min, window) => window.startHour < min ? window.startHour : min, windows[0]!.startHour),
    end: windows.reduce((max, window) => window.endHour > max ? window.endHour : max, windows[0]!.endHour),
  };
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
