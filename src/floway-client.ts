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
    return await this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { username, password },
      secretHints: [password, this.options.adminKey],
    });
  }

  async getMe(session: string): Promise<AuthMeResponse> {
    return await this.userRequest<AuthMeResponse>(session, '/auth/me');
  }

  async listUsers(): Promise<FlowayAdminUser[]> {
    return await this.adminRequest<FlowayAdminUser[]>('/api/users');
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
    return await this.userRequest<ApiKeyRecord>(session, `/api/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
  }

  async listUpstreams(): Promise<UpstreamRecord[]> {
    return await this.adminRequest<UpstreamRecord[]>('/api/upstreams');
  }

  async getUpstreamModels(id: string): Promise<UpstreamModelsResponse> {
    return await this.adminRequest<UpstreamModelsResponse>(`/api/upstreams/${encodeURIComponent(id)}/models`);
  }

  async getCopilotQuota(id: string): Promise<CopilotQuotaResponse> {
    return await this.adminRequest<CopilotQuotaResponse>(`/api/upstreams/${encodeURIComponent(id)}/copilot/quota`);
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

    const payload = await this.adminRequest<FlowayExportPayload>('/api/export');
    const snapshot: SanitizedExportSnapshot = {
      exportedAt: payload.exportedAt,
      users: payload.data.users.map(user => ({
        id: user.id,
        username: user.username,
        deletedAt: user.deletedAt,
      })),
      apiKeys: payload.data.apiKeys.map(({ key: _key, ...rest }) => rest),
      usage: payload.data.usage.map(record => ({
        keyId: record.keyId,
        model: record.model,
        upstream: record.upstream,
        modelKey: record.modelKey,
        hour: record.hour,
        requests: record.requests,
        tokens: { ...record.tokens },
        cost: record.cost ? { ...record.cost } : null,
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

interface ApiRequestInit {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  body?: unknown;
  session?: string;
  secretHints?: string[];
}
