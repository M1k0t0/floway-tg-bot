import { describe, expect, it } from 'vitest';

import { FlowayClient, FlowayHttpError } from '../src/floway-client.js';

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
        return jsonResponse({ token: `admin-session-${loginCount}`, user: { id: 1, username: 'admin', isAdmin: true, canViewGlobalTelemetry: true, upstreamIds: null } });
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
        return jsonResponse({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, canViewGlobalTelemetry: true, upstreamIds: null } });
      }
      exportCalls += 1;
      return jsonResponse({
        version: 6,
        exportedAt: '2026-06-21T00:00:00.000Z',
        data: {
          users: [{ id: 1, username: 'admin', deletedAt: null }],
          apiKeys: [{ id: 'k', userId: 1, name: 'Key', key: 'raw-secret', createdAt: 'x', upstreamIds: null, deletedAt: null }],
          upstreams: [],
          usage: [],
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
