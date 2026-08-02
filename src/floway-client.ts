import { redactText, redactValue } from './redact.js';
import type {
  ApiKeyRecord,
  AuthMeResponse,
  CopilotQuotaResponse,
  FlowayAdminUser,
  FlowayExportPayload,
  LoginResponse,
  SanitizedExportSnapshot,
  TokenUsageResponse,
  UpstreamModelsResponse,
  UpstreamRecord,
} from './types.js';

export interface FlowayClientOptions {
  baseUrl: string;
  adminKey: string;
  usageExportCacheTtlSeconds: number;
  fetchImpl?: typeof fetch;
}

export class FlowayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'FlowayHttpError';
  }
}

export class FlowayClient {
  private adminSession: string | null = null;
  private adminLoginPromise: Promise<string> | null = null;
  private exportCache: { expiresAt: number; snapshot: SanitizedExportSnapshot } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FlowayClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    return validateLoginResponse(await this.request<unknown>('/auth/login', {
      method: 'POST',
      body: { username, password },
      secretHints: [password, this.options.adminKey],
    }));
  }

  async getMe(session: string): Promise<AuthMeResponse> {
    return validateAuthMeResponse(await this.userRequest<unknown>(session, '/auth/me'));
  }

  async listUsers(): Promise<FlowayAdminUser[]> {
    return validateAdminUsers(await this.adminRequest<unknown>('/api/users'));
  }

  async logout(session: string): Promise<{ ok: true }> {
    return await this.userRequest<{ ok: true }>(session, '/auth/logout', { method: 'POST' });
  }

  async listKeys(session: string): Promise<ApiKeyRecord[]> {
    return await this.userRequest<ApiKeyRecord[]>(session, '/api/keys');
  }

  async createKey(session: string, name: string, upstreamIds: string[] | null): Promise<ApiKeyRecord> {
    return await this.userRequest<ApiKeyRecord>(session, '/api/keys', {
      method: 'POST',
      body: { name, upstream_ids: upstreamIds },
    });
  }

  async deleteKey(session: string, id: string): Promise<{ ok: true }> {
    return await this.userRequest<{ ok: true }>(session, `/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async rotateKey(session: string, id: string): Promise<ApiKeyRecord> {
    return await this.userRequest<ApiKeyRecord>(session, `/api/keys/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
      body: {},
    });
  }

  async listUpstreams(): Promise<UpstreamRecord[]> {
    return validateUpstreams(await this.adminRequest<unknown>('/api/upstreams'));
  }

  async getUpstream(id: string): Promise<UpstreamRecord> {
    return validateUpstream(await this.adminRequest<unknown>(`/api/upstreams/${encodeURIComponent(id)}`));
  }

  async getUpstreamModels(record: UpstreamRecord): Promise<UpstreamModelsResponse> {
    return await this.adminRequest<UpstreamModelsResponse>('/api/upstreams/list-models', {
      method: 'POST',
      body: { record },
    });
  }

  async getCopilotQuota(record: UpstreamRecord): Promise<CopilotQuotaResponse> {
    return await this.adminRequest<CopilotQuotaResponse>('/api/upstreams/copilot/quota', {
      method: 'POST',
      body: { record },
    });
  }

  async getTokenUsage(session: string, start: string, end: string): Promise<TokenUsageResponse> {
    const query = new URLSearchParams({
      start,
      end,
      view: 'self-by-key',
      include_key_metadata: '1',
    });
    return await this.userRequest<TokenUsageResponse>(session, `/api/token-usage?${query.toString()}`);
  }

  async exportUsageSnapshot(): Promise<SanitizedExportSnapshot> {
    const now = Date.now();
    if (this.exportCache && this.exportCache.expiresAt > now) return this.exportCache.snapshot;

    const payload = validateExportPayload(await this.adminRequest<unknown>('/api/export'));
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: payload.exportedAt,
      users: payload.data.users.map(user => ({
        id: user.id,
        username: user.username,
        deletedAt: user.deletedAt,
      })),
      apiKeys: payload.data.apiKeys.map(apiKey => ({
        id: apiKey.id,
        userId: apiKey.userId,
        name: apiKey.name,
        createdAt: apiKey.createdAt,
        ...(apiKey.lastUsedAt !== undefined ? { lastUsedAt: apiKey.lastUsedAt } : {}),
        upstreamIds: apiKey.upstreamIds,
        deletedAt: apiKey.deletedAt,
        dumpRetentionSeconds: apiKey.dumpRetentionSeconds,
        responsesRetentionSeconds: apiKey.responsesRetentionSeconds,
      })),
      usage: payload.data.usage.map(record => ({
        keyId: record.keyId,
        model: record.model,
        upstream: record.upstream,
        modelKey: record.modelKey,
        hour: record.hour,
        pricingSelector: { ...record.pricingSelector },
        requests: record.requests,
        metrics: record.metrics.map(metric => ({ ...metric })),
      })),
    };
    this.exportCache = {
      expiresAt: now + this.options.usageExportCacheTtlSeconds * 1000,
      snapshot,
    };
    return snapshot;
  }

  private async userRequest<T>(session: string, path: string, init: ApiRequestInit = {}): Promise<T> {
    return await this.request<T>(path, {
      ...init,
      session,
      secretHints: [session, ...(init.secretHints ?? [])],
    });
  }

  private async adminRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
    const session = await this.getAdminSession();
    try {
      return await this.request<T>(path, {
        ...init,
        session,
        secretHints: [session, this.options.adminKey, ...(init.secretHints ?? [])],
      });
    } catch (error) {
      if (!(error instanceof FlowayHttpError) || error.status !== 401) throw error;
      this.adminSession = null;
      const freshSession = await this.getAdminSession();
      return await this.request<T>(path, {
        ...init,
        session: freshSession,
        secretHints: [freshSession, this.options.adminKey, ...(init.secretHints ?? [])],
      });
    }
  }

  private async getAdminSession(): Promise<string> {
    if (this.adminSession) return this.adminSession;
    if (!this.adminLoginPromise) {
      this.adminLoginPromise = this.login('', this.options.adminKey)
        .then(response => {
          this.adminSession = response.token;
          return response.token;
        })
        .finally(() => {
          this.adminLoginPromise = null;
        });
    }
    return await this.adminLoginPromise;
  }

  private async request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
    const url = `${this.options.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.session) headers.set('x-floway-session', init.session);

    let response: Response;
    try {
      const requestInit: NonNullable<Parameters<typeof fetch>[1]> = {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
      };
      if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
      response = await this.fetchImpl(url, {
        ...requestInit,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FlowayHttpError(0, redactText(message, init.secretHints));
    }

    let parsed: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.error === 'string') message = obj.error;
        else if (obj.error && typeof obj.error === 'object' && typeof (obj.error as Record<string, unknown>).message === 'string') {
          message = (obj.error as { message: string }).message;
        }
      } else if (typeof parsed === 'string' && parsed.length > 0) {
        message = parsed;
      }
      throw new FlowayHttpError(response.status, redactText(message, init.secretHints), redactValue(parsed));
    }

    return parsed as T;
  }
}

const validateLoginResponse = (value: unknown): LoginResponse => {
  const record = requireRecord(value, 'login response');
  if (typeof record.token !== 'string' || record.token.length === 0) throw invalidResponse('login response');
  return { token: record.token, user: validateFlowayUser(record.user, 'login user') };
};

const validateAuthMeResponse = (value: unknown): AuthMeResponse => {
  const record = requireRecord(value, 'session response');
  if (typeof record.viaApiKey !== 'boolean') throw invalidResponse('session response');
  validateFlowayUser(record.user, 'session user');
  if (record.apiKey !== null) {
    const apiKey = requireRecord(record.apiKey, 'session API key');
    if (typeof apiKey.id !== 'string' || typeof apiKey.name !== 'string') throw invalidResponse('session API key');
  }
  return value as AuthMeResponse;
};

const validateAdminUsers = (value: unknown): FlowayAdminUser[] => {
  if (!Array.isArray(value)) throw invalidResponse('users response');
  return value.map((item, index) => {
    const user = validateFlowayUser(item, `user ${index}`);
    const record = item as Record<string, unknown>;
    if (typeof record.createdAt !== 'string') throw invalidResponse(`user ${index}`);
    return { ...user, createdAt: record.createdAt };
  });
};

const validateFlowayUser = (value: unknown, label: string): FlowayAdminUser => {
  const record = requireRecord(value, label);
  if (!Number.isSafeInteger(record.id) || (record.id as number) < 1
    || typeof record.username !== 'string'
    || typeof record.isAdmin !== 'boolean'
    || !(record.upstreamIds === null
      || (Array.isArray(record.upstreamIds) && record.upstreamIds.every(id => typeof id === 'string')))) {
    throw invalidResponse(label);
  }
  return record as unknown as FlowayAdminUser;
};

const validateUpstreams = (value: unknown): UpstreamRecord[] => {
  if (!Array.isArray(value)) throw invalidResponse('upstreams response');
  return value.map((item, index) => validateUpstream(item, `upstream ${index}`));
};

const validateUpstream = (value: unknown, label = 'upstream response'): UpstreamRecord => {
  const record = requireRecord(value, label);
  if (typeof record.id !== 'string' || record.id.length === 0
    || typeof record.kind !== 'string'
    || typeof record.name !== 'string'
    || typeof record.enabled !== 'boolean'
    || !Number.isSafeInteger(record.sort_order)
    || typeof record.created_at !== 'string'
    || typeof record.updated_at !== 'string'
    || !isRecord(record.flag_overrides)
    || !isRecord(record.flag_defaults)
    || !isStringArray(record.disabled_public_model_ids)
    || !Array.isArray(record.proxy_fallback_list)) {
    throw invalidResponse(label);
  }
  return record as unknown as UpstreamRecord;
};

const validateExportPayload = (value: unknown): FlowayExportPayload => {
  const payload = requireRecord(value, 'export response');
  const data = requireRecord(payload.data, 'export data');
  if (payload.version !== 17
    || typeof payload.exportedAt !== 'string'
    || !Array.isArray(data.users)
    || !Array.isArray(data.apiKeys)
    || !Array.isArray(data.upstreams)
    || !Array.isArray(data.usage)) {
    throw invalidResponse('export response');
  }
  data.users.forEach((item, index) => {
    const user = requireRecord(item, `export user ${index}`);
    if (!Number.isSafeInteger(user.id) || typeof user.username !== 'string'
      || !(user.deletedAt === null || typeof user.deletedAt === 'string')) throw invalidResponse(`export user ${index}`);
  });
  data.apiKeys.forEach((item, index) => {
    const key = requireRecord(item, `export API key ${index}`);
    if (typeof key.id !== 'string' || !Number.isSafeInteger(key.userId) || typeof key.name !== 'string'
      || typeof key.createdAt !== 'string' || !Array.isArray(key.upstreamIds) && key.upstreamIds !== null) {
      throw invalidResponse(`export API key ${index}`);
    }
  });
  data.usage.forEach((item, index) => {
    const usage = requireRecord(item, `usage record ${index}`);
    if (typeof usage.keyId !== 'string' || typeof usage.model !== 'string'
      || !(usage.upstream === null || typeof usage.upstream === 'string')
      || typeof usage.modelKey !== 'string' || typeof usage.hour !== 'string'
      || !Number.isSafeInteger(usage.requests) || !Array.isArray(usage.metrics)
      || !isRecord(usage.pricingSelector)) {
      throw invalidResponse(`usage record ${index}`);
    }
  });
  return value as FlowayExportPayload;
};

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw invalidResponse(label);
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const invalidResponse = (label: string): TypeError => new TypeError(`Invalid Floway ${label}`);

interface ApiRequestInit {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  body?: unknown;
  session?: string;
  secretHints?: string[];
}
