import { describe, expect, it } from 'vitest';

import { formatInfo, formatKeys, formatUpstreamList } from '../src/format.js';
import type { ApiKeyRecord, UpstreamRecord } from '../src/types.js';

describe('formatters', () => {
  it('escapes dynamic upstream fields for Telegram HTML', () => {
    const upstream: UpstreamRecord = {
      id: 'up_<a>&',
      provider: 'codex',
      name: 'Codex <main> & shared',
      enabled: true,
      sort_order: 1,
      created_at: '2026-06-21T00:00:00.000Z',
      updated_at: '2026-06-21T00:00:00.000Z',
      flag_overrides: {},
      disabled_public_model_ids: [],
      proxy_fallback_list: [],
      config: {},
      state: null,
    };

    const text = formatUpstreamList([upstream]);
    expect(text).toContain('Codex &lt;main&gt; &amp; shared');
    expect(text).toContain('<code>up_&lt;a&gt;&amp;</code>');
  });

  it('escapes generated key secrets and labels them clearly', () => {
    const key: ApiKeyRecord = {
      id: 'key_1',
      name: 'main <prod>',
      key: 'sk-test',
      created_at: '2026-06-21T00:00:00.000Z',
      last_used_at: null,
      upstream_ids: ['up_a'],
    };

    const text = formatKeys([key]);
    expect(text).toContain('<b>main &lt;prod&gt;</b>');
    expect(text).toContain('<code>up_a</code>');
  });

  it('formats endpoint info and escapes the base URL', () => {
    const text = formatInfo('https://floway.example/<edge>&');
    expect(text).toContain('<b>Floway client info</b>');
    expect(text).toContain('<code>https://floway.example/&lt;edge&gt;&amp;/v1/responses</code>');
    expect(text).toContain('Use /keys to view your keys.');
    expect(text).toContain('Authorization: Bearer &lt;key&gt;');
  });
});
