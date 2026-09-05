export interface AppConfig {
  telegramBotToken: string;
  flowayBaseUrl: string;
  flowayAdminKey: string;
  botDbPath: string;
  botSecretKey: Buffer;
  usageExportCacheTtlSeconds: number;
  quotaWindowNotifyIntervalSeconds: number;
}

export interface FlowayUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
}

export interface FlowayAdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
  createdAt: string;
}

export interface AuthMeResponse {
  user: FlowayUser;
  viaApiKey: boolean;
  apiKey: { id: string; name: string } | null;
}

export interface LoginResponse {
  token: string;
  user: FlowayUser;
}

export interface Binding {
  bindingId: number;
  telegramUserId: string;
  flowayUserId: number;
  username: string;
  flowaySession: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string[] | null;
  dump_retention_seconds: number | null;
  responses_retention_seconds: number;
}

export interface ModelsCacheStatus {
  fetchedAt: number | null;
  lastError: { message: string; at: number } | null;
}

export interface CodexQuotaSnapshot {
  observed_at: string;
  active_limit?: string;
  plan_type?: string;
  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;
  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;
  credits_has_credits?: boolean;
  credits_balance?: number;
  ratelimited_until?: string;
}

export interface UpstreamRecord {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  updated_at: string;
  modelsCache?: ModelsCacheStatus;
  codex_quota: unknown;
  raw: Record<string, unknown>;
}

export interface UpstreamModelRecord {
  upstreamModelId: string;
  publicModelId: string;
  kind?: string;
  endpoints: Record<string, unknown>;
  display_name?: string;
  limits?: Record<string, number>;
  pricing?: ModelPricing;
}

export interface UpstreamModelsResponse {
  data: UpstreamModelRecord[];
}

export type BillingDimension =
  | 'input'
  | 'output'
  | 'input_cache_read'
  | 'input_cache_write'
  | 'input_cache_write_1h'
  | 'input_image'
  | 'input_audio'
  | 'output_image';

export type TokenUsage = Partial<Record<BillingDimension, number>>;
export type DecimalString = string;

export type BillingMetric =
  | 'input_tokens'
  | 'input_cache_read_tokens'
  | 'input_cache_write_tokens'
  | 'input_cache_write_1h_tokens'
  | 'input_image_tokens'
  | 'input_audio_tokens'
  | 'input_audio_seconds'
  | 'output_tokens'
  | 'output_image_tokens'
  | 'rerank_searches';

export interface PricingThresholdCoordinate {
  readonly operator: 'gt' | 'gte';
  readonly value: number;
}

export type PricingCoordinateValue = string | PricingThresholdCoordinate;
export type PricingSelector = Readonly<Record<string, PricingCoordinateValue>>;
export type PriceVector = Partial<Record<BillingMetric, DecimalString>>;

export interface ModelPricing {
  entries: ReadonlyArray<{
    selector?: PricingSelector;
    rates: PriceVector;
  }>;
}

export interface UsageMetricRecord {
  readonly metric: BillingMetric;
  readonly quantity: DecimalString;
  readonly unitPrice: DecimalString | null;
}

export interface UsageRecord {
  readonly keyId: string;
  readonly model: string;
  readonly upstream: string | null;
  readonly modelKey: string;
  readonly hour: string;
  readonly pricingSelector: PricingSelector;
  readonly requests: number;
  readonly metrics: ReadonlyArray<UsageMetricRecord>;
}

export interface UsageApiKeyIdentity {
  readonly id: string;
  readonly userId: number;
}

export interface FlowayExportPayload {
  version: number;
  exportedAt: string;
  data: {
    users: Array<{ id: number; username: string; deletedAt: string | null }>;
    apiKeys: UsageApiKeyIdentity[];
    upstreams: unknown[];
    usage: UsageRecord[];
  };
}

export interface GlobalUsageSnapshot {
  readonly exportedAt: string;
  readonly users: ReadonlyArray<{
    readonly id: number;
    readonly username: string;
    readonly deletedAt: string | null;
  }>;
  readonly apiKeys: ReadonlyArray<UsageApiKeyIdentity>;
  readonly usage: ReadonlyArray<UsageRecord>;
}

export interface DisplayUsageMetric {
  metric: BillingMetric;
  quantity: DecimalString;
}

export interface DisplayUsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  metrics: DisplayUsageMetric[];
  cost: DecimalString | null;
  keyName: string;
  keyCreatedAt: string;
}

export interface TokenUsageResponse {
  records: DisplayUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt: string }>;
}

export interface CopilotQuotaResponse {
  quota_reset_date?: string;
  quota_snapshots?: Record<string, unknown>;
  [key: string]: unknown;
}
