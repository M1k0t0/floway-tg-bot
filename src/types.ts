export interface AppConfig {
  telegramBotToken: string;
  flowayBaseUrl: string;
  flowayAdminKey: string;
  botDbPath: string;
  botSecretKey: Buffer;
  usageExportCacheTtlSeconds: number;
}

export interface FlowayUser {
  id: number;
  username: string;
  isAdmin: boolean;
  canViewGlobalTelemetry: boolean;
  upstreamIds: string[] | null;
}

export interface FlowayAdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  canViewGlobalTelemetry: boolean;
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
  provider: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: Record<string, boolean>;
  disabled_public_model_ids: string[];
  proxy_fallback_list: Array<{ id: string; colos?: string[] }>;
  config: unknown;
  state: unknown;
  modelsCache?: ModelsCacheStatus;
  codex_quota?: CodexQuotaSnapshot | null;
}

export interface UpstreamModelRecord {
  upstreamModelId: string;
  publicModelId: string;
  kind?: string;
  endpoints: Record<string, unknown>;
  display_name?: string;
  limits?: Record<string, number>;
  cost?: ModelPricing;
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
  | 'output_image';

export type TokenUsage = Partial<Record<BillingDimension, number>>;
export type ModelPricing = Partial<Record<BillingDimension, number>>;

export interface UsageRecord {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  requests: number;
  tokens: TokenUsage;
  cost: ModelPricing | null;
}

export interface ExportApiKey {
  id: string;
  userId: number;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
  upstreamIds: string[] | null;
  deletedAt: string | null;
}

export interface FlowayExportPayload {
  version: number;
  exportedAt: string;
  data: {
    users: Array<{ id: number; username: string; deletedAt: string | null }>;
    apiKeys: ExportApiKey[];
    upstreams: UpstreamRecord[];
    usage: UsageRecord[];
  };
}

export interface SanitizedExportSnapshot {
  exportedAt: string;
  users: Array<{ id: number; username: string; deletedAt: string | null }>;
  apiKeys: Array<Omit<ExportApiKey, 'key'>>;
  usage: UsageRecord[];
}

export interface DisplayUsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  tokens: TokenUsage;
  cost: number;
  keyName?: string;
  keyCreatedAt?: string;
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
