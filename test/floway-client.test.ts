import { describe, expect, it, vi } from 'vitest';

import { FlowayClient, FlowayHttpError } from '../src/floway-client.js';

const rawUpstream = (id: string, kind = 'copilot') => ({
  id,
  kind,
  name: id,
  enabled: true,
  sort_order: 0,
  created_at: '2026-06-21T00:00:00.000Z',
  updated_at: '2026-06-21T00:00:00.000Z',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  hue: 0,
  config: { githubToken: 'github-secret' },
  state: { copilotToken: 'copilot-secret' },
});

const expectedUpstream = (raw: ReturnType<typeof rawUpstream>) => ({
  id: raw.id,
  kind: raw.kind,
  name: raw.name,
  enabled: raw.enabled,
  sort_order: raw.sort_order,
  updated_at: raw.updated_at,
  codex_quota: undefined,
  raw,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const createClient = (fetchImpl: typeof fetch): FlowayClient => new FlowayClient({
  baseUrl: 'https://floway.example',
  adminKey: 'admin-secret',
  usageExportCacheTtlSeconds: 30,
  fetchImpl,
});

const adminLoginResponse = () => jsonResponse({
  token: 'admin-session',
  user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
});

describe('FlowayClient', () => {
  it('logs admin in once and retries admin requests once after a 401', async () => {
    const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
    let loginCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body?.toString();
      calls.push({ url, headers: new Headers(init?.headers), ...(body !== undefined ? { body } : {}) });
      if (url.endsWith('/auth/login')) {
        loginCount += 1;
        return jsonResponse({ token: `admin-session-${loginCount}`, user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null } });
      }
      if (url.endsWith('/api/upstreams') && calls.filter(call => call.url.endsWith('/api/upstreams')).length === 1) {
        return jsonResponse({ error: 'Invalid session' }, { status: 401 });
      }
      return jsonResponse([]);
    };

    const client = createClient(fetchImpl);

    expect(await client.listUpstreams()).toEqual([]);
    expect(loginCount).toBe(2);
    const upstreamCalls = calls.filter(call => call.url.endsWith('/api/upstreams'));
    expect(upstreamCalls.map(call => call.headers.get('x-floway-session'))).toEqual(['admin-session-1', 'admin-session-2']);
  });

  it('parses only bot-owned fields and accepts unknown non-empty kinds', async () => {
    const record = {
      ...rawUpstream('up_a', 'future-provider'),
      modelsCache: {
        fetchedAt: 1_765_843_200_000,
        lastError: { message: 'temporary', at: 1_765_843_201_000 },
        modelCount: 42,
      },
      unrelated: { future: true },
    };
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login') ? adminLoginResponse() : jsonResponse([record]);

    await expect(createClient(fetchImpl).listUpstreams()).resolves.toEqual([{
      id: 'up_a',
      kind: 'future-provider',
      name: 'up_a',
      enabled: true,
      sort_order: 0,
      updated_at: '2026-06-21T00:00:00.000Z',
      modelsCache: {
        fetchedAt: 1_765_843_200_000,
        lastError: { message: 'temporary', at: 1_765_843_201_000 },
      },
      codex_quota: undefined,
      raw: record,
    }]);
  });

  it.each([
    ['missing id', { id: undefined }],
    ['empty id', { id: '' }],
    ['empty kind', { kind: '' }],
    ['invalid name', { name: 1 }],
    ['invalid enabled', { enabled: 'yes' }],
    ['invalid sort order', { sort_order: 1.5 }],
    ['invalid update timestamp', { updated_at: null }],
  ])('rejects an upstream with %s', async (_label, override) => {
    const record = { ...rawUpstream('secret-upstream'), ...override };
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login') ? adminLoginResponse() : jsonResponse([record]);
    const client = createClient(fetchImpl);

    await expect(client.listUpstreams()).rejects.toThrow('Invalid Floway upstream 0');
    await expect(client.listUpstreams()).rejects.not.toThrow('secret-upstream');
  });

  it.each([
    ['missing', undefined],
    ['non-object', 'bad'],
    ['bad fetched time', { fetchedAt: 'bad', lastError: null }],
    ['bad last error', { fetchedAt: null, lastError: { message: 1, at: 2 } }],
  ])('omits a %s models cache without rejecting the upstream', async (_label, modelsCache) => {
    const record = { ...rawUpstream('up_a'), ...(modelsCache !== undefined ? { modelsCache } : {}) };
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login') ? adminLoginResponse() : jsonResponse([record]);

    await expect(createClient(fetchImpl).listUpstreams()).resolves.toEqual([expectedUpstream(record)]);
  });

  it('preserves primary and secondary Codex quota fields for the quota parser', async () => {
    const codexQuota = {
      plus: {
        observed_at: '2026-07-01T01:00:00.000Z',
        active_limit: 'premium',
        primary_window_minutes: 300,
        primary_reset_after_at: '2026-07-01T05:00:00.000Z',
        primary_used_percent: 15,
        secondary_window_minutes: 10_080,
        secondary_reset_after_at: '2026-07-08T00:00:00.000Z',
        secondary_used_percent: 75,
      },
    };
    const record = { ...rawUpstream('up_a', 'codex'), codex_quota: codexQuota };
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login') ? adminLoginResponse() : jsonResponse([record]);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-01T01:00:00.000Z'));
    try {
      const parsed = (await createClient(fetchImpl).listUpstreams())[0]!;
      expect(parsed.codex_quota).toEqual(codexQuota);
      expect(parsed.raw).toEqual(record);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not validate quota shape based on upstream kind', async () => {
    const records = [
      { ...rawUpstream('codex_malformed', 'codex'), codex_quota: 'malformed' },
      { ...rawUpstream('other_with_quota', 'future-provider'), codex_quota: ['opaque'] },
    ];
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login') ? adminLoginResponse() : jsonResponse(records);

    const parsed = await createClient(fetchImpl).listUpstreams();
    expect(parsed.map(upstream => upstream.codex_quota)).toEqual(['malformed', ['opaque']]);
  });

  it('filters stale Codex quota in the DTO while retaining the exact raw record', async () => {
    const now = Date.parse('2026-07-10T12:00:00.000Z');
    const freshAtFloor = {
      observed_at: '2026-07-09T12:00:00.000Z',
      active_limit: 'premium',
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-07-09T17:00:00.000Z',
      primary_used_percent: 15,
    };
    const keptByFutureHorizon = {
      observed_at: '2026-07-08T12:00:00.000Z',
      active_limit: 'premium',
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-07-13T12:00:00.000Z',
      primary_used_percent: 25,
    };
    const stale = {
      observed_at: '2026-07-08T12:00:00.000Z',
      active_limit: 'premium',
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-07-08T17:00:00.000Z',
      primary_used_percent: 35,
    };
    const malformed = {
      observed_at: 'bad',
      active_limit: 'premium',
      primary_window_minutes: 300,
      primary_reset_after_at: 'bad',
      primary_used_percent: 45,
    };
    const rawQuota = { freshAtFloor, keptByFutureHorizon, stale, malformed };
    const record = { ...rawUpstream('up_a', 'codex'), codex_quota: rawQuota };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) return adminLoginResponse();
      return jsonResponse(url.endsWith('/api/upstreams/up_a') ? record : [record]);
    };
    const client = createClient(fetchImpl);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const expectedQuota = { freshAtFloor, keptByFutureHorizon, malformed };
      for (const parsed of [(await client.listUpstreams())[0]!, await client.getUpstream('up_a')]) {
        expect(parsed.codex_quota).toEqual(expectedQuota);
        expect(parsed.raw).toEqual(record);
        expect(parsed.raw.codex_quota).toEqual(rawQuota);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('maps a fully expired Codex quota map to null without changing raw', async () => {
    const rawQuota = {
      premium: {
        observed_at: '2026-07-08T12:00:00.000Z',
        active_limit: 'premium',
        primary_window_minutes: 300,
        primary_reset_after_at: '2026-07-08T17:00:00.000Z',
        primary_used_percent: 35,
      },
    };
    const record = { ...rawUpstream('up_a', 'codex'), codex_quota: rawQuota };
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login') ? adminLoginResponse() : jsonResponse([record]);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-10T12:00:00.000Z'));
    try {
      const parsed = (await createClient(fetchImpl).listUpstreams())[0]!;
      expect(parsed.codex_quota).toBeNull();
      expect(parsed.raw.codex_quota).toEqual(rawQuota);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('sanitizes exported api key secrets and caches the raw export briefly', async () => {
    let exportCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) return adminLoginResponse();
      exportCalls += 1;
      return jsonResponse({
        version: 20,
        exportedAt: '2026-06-21T00:00:00.000Z',
        data: {
          users: [{ id: 1, username: 'admin', deletedAt: null }],
          apiKeys: [{
            id: 'k',
            userId: 1,
            name: 'Key',
            key: 'raw-secret',
            serverSecret: 'server-secret',
            createdAt: 'x',
            lastUsedAt: 'y',
            upstreamIds: null,
            deletedAt: null,
            dumpRetentionSeconds: 60,
            responsesRetentionSeconds: 86400,
          }],
          upstreams: [],
          usage: [{
            keyId: 'k',
            model: 'm',
            upstream: 'up_a',
            modelKey: 'm',
            hour: '2026-06-21T00',
            pricingSelector: { serviceTier: 'priority' },
            requests: 1,
            metrics: [{ metric: 'input_tokens', quantity: '10', unitPrice: '0.000001' }],
          }],
        },
      });
    };

    const client = createClient(fetchImpl);
    const first = await client.exportUsageSnapshot();
    const second = await client.exportUsageSnapshot();

    expect(exportCalls).toBe(1);
    expect(first).toBe(second);
    expect('key' in first.apiKeys[0]!).toBe(false);
    expect('serverSecret' in first.apiKeys[0]!).toBe(false);
    expect(first.apiKeys[0]).toMatchObject({
      id: 'k',
      lastUsedAt: 'y',
      dumpRetentionSeconds: 60,
      responsesRetentionSeconds: 86400,
    });
    expect(first.usage[0]).toEqual({
      keyId: 'k',
      model: 'm',
      upstream: 'up_a',
      modelKey: 'm',
      hour: '2026-06-21T00',
      pricingSelector: { serviceTier: 'priority' },
      requests: 1,
      metrics: [{ metric: 'input_tokens', quantity: '10', unitPrice: '0.000001' }],
    });
  });

  it('rejects malformed export envelopes before mapping nested arrays', async () => {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/login')
        ? adminLoginResponse()
        : jsonResponse({ version: 20, exportedAt: 'x', data: { users: 'not-an-array' } });

    await expect(createClient(fetchImpl).exportUsageSnapshot()).rejects.toThrow('Invalid Floway export response');
  });

  it('posts the exact opaque raw record to model and Copilot quota actions', async () => {
    const record = { ...rawUpstream('up one'), futureField: { preserved: true } };
    const calls: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        ...(init?.method !== undefined ? { method: init.method } : {}),
        headers: new Headers(init?.headers),
        ...(init?.body != null ? { body: init.body.toString() } : {}),
      });
      if (url.endsWith('/auth/login')) return adminLoginResponse();
      if (url.endsWith('/api/upstreams/up%20one')) return jsonResponse(record);
      if (url.endsWith('/api/upstreams/list-models')) return jsonResponse({ data: [] });
      if (url.endsWith('/api/upstreams/copilot/quota')) return jsonResponse({ quota_reset_date: '2026-07-01' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    };
    const client = createClient(fetchImpl);

    const upstream = await client.getUpstream('up one');
    await client.getUpstreamModels(upstream);
    await client.getCopilotQuota(upstream);

    const actionCalls = calls.filter(call => !call.url.endsWith('/auth/login'));
    expect(actionCalls.map(call => ({
      url: call.url,
      method: call.method,
      body: call.body,
      session: call.headers.get('x-floway-session'),
      contentType: call.headers.get('content-type'),
    }))).toEqual([
      {
        url: 'https://floway.example/api/upstreams/up%20one',
        method: 'GET',
        body: undefined,
        session: 'admin-session',
        contentType: null,
      },
      {
        url: 'https://floway.example/api/upstreams/list-models',
        method: 'POST',
        body: JSON.stringify({ record }),
        session: 'admin-session',
        contentType: 'application/json',
      },
      {
        url: 'https://floway.example/api/upstreams/copilot/quota',
        method: 'POST',
        body: JSON.stringify({ record }),
        session: 'admin-session',
        contentType: 'application/json',
      },
    ]);
  });

  it('sends an empty JSON object when rotating a generated key', async () => {
    const calls: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        ...(init?.method !== undefined ? { method: init.method } : {}),
        headers: new Headers(init?.headers),
        ...(init?.body != null ? { body: init.body.toString() } : {}),
      });
      return jsonResponse({
        id: 'key_1',
        name: 'Key',
        key: 'rotated',
        created_at: 'x',
        last_used_at: null,
        upstream_ids: null,
        dump_retention_seconds: null,
        responses_retention_seconds: 0,
      });
    };
    const client = createClient(fetchImpl);

    await client.rotateKey('user-session', 'key 1');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://floway.example/api/keys/key%201/rotate',
      method: 'POST',
      body: '{}',
    });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.get('x-floway-session')).toBe('user-session');
  });

  it('redacts secret hints from request errors', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network failed with admin-secret');
    };
    const client = createClient(fetchImpl);

    await expect(client.login('', 'admin-secret')).rejects.toMatchObject({
      status: 0,
      message: 'network failed with [redacted]',
    });
  });

  it('redacts structured error bodies', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: 'bad password admin-secret', token: 'leaked' }, { status: 400 });
    const client = createClient(fetchImpl);

    await expect(client.login('', 'admin-secret')).rejects.toBeInstanceOf(FlowayHttpError);
    try {
      await client.login('', 'admin-secret');
    } catch (error) {
      expect(error).toBeInstanceOf(FlowayHttpError);
      expect((error as FlowayHttpError).message).toBe('bad password [redacted]');
      expect((error as FlowayHttpError).raw).toEqual({ error: 'bad password admin-secret', token: '[redacted]' });
    }
  });
});
