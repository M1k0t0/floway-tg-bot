import { describe, expect, it } from 'vitest';

import { FlowayClient, FlowayHttpError } from '../src/floway-client.js';
import type { UpstreamRecord } from '../src/types.js';

const upstream = (id: string, kind = 'copilot'): UpstreamRecord => ({
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
  color: null,
  config: { githubToken: 'github-secret' },
  state: { copilotToken: 'copilot-secret' },
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

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

    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

    expect(await client.listUpstreams()).toEqual([]);
    expect(loginCount).toBe(2);
    const upstreamCalls = calls.filter(call => call.url.endsWith('/api/upstreams'));
    expect(upstreamCalls.map(call => call.headers.get('x-floway-session'))).toEqual(['admin-session-1', 'admin-session-2']);
  });

  it('sanitizes exported api key secrets and caches the raw export briefly', async () => {
    let exportCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return jsonResponse({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null } });
      }
      exportCalls += 1;
      return jsonResponse({
        version: 17,
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

    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

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

  it('rejects malformed successful response shapes without exposing payload values', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return jsonResponse({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null } });
      }
      return jsonResponse([{ id: 'secret-upstream', kind: 'codex' }]);
    };
    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

    await expect(client.listUpstreams()).rejects.toThrow('Invalid Floway upstream 0');
    await expect(client.listUpstreams()).rejects.not.toThrow('secret-upstream');
  });

  it('rejects malformed export envelopes before mapping nested arrays', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return jsonResponse({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null } });
      }
      return jsonResponse({ version: 17, exportedAt: 'x', data: { users: 'not-an-array' } });
    };
    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

    await expect(client.exportUsageSnapshot()).rejects.toThrow('Invalid Floway export response');
  });

  it('fetches a full upstream record and posts it to model and Copilot quota actions', async () => {
    const record = upstream('up one');
    const calls: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        ...(init?.method !== undefined ? { method: init.method } : {}),
        headers: new Headers(init?.headers),
        ...(init?.body != null ? { body: init.body.toString() } : {}),
      });
      if (url.endsWith('/auth/login')) {
        return jsonResponse({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null } });
      }
      if (url.endsWith('/api/upstreams/up%20one')) return jsonResponse(record);
      if (url.endsWith('/api/upstreams/list-models')) return jsonResponse({ data: [] });
      if (url.endsWith('/api/upstreams/copilot/quota')) return jsonResponse({ quota_reset_date: '2026-07-01' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    };
    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

    const fullRecord = await client.getUpstream('up one');
    await client.getUpstreamModels(fullRecord);
    await client.getCopilotQuota(fullRecord);

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
    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

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
    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

    await expect(client.login('', 'admin-secret')).rejects.toMatchObject({
      status: 0,
      message: 'network failed with [redacted]',
    });
  });

  it('redacts structured error bodies', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: 'bad password admin-secret', token: 'leaked' }, { status: 400 });
    const client = new FlowayClient({
      baseUrl: 'https://floway.example',
      adminKey: 'admin-secret',
      usageExportCacheTtlSeconds: 30,
      fetchImpl,
    });

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
