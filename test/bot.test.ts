import { describe, expect, it } from 'vitest';

import { parseNewKeyArgs, selectUpstream } from '../src/bot.js';
import type { UpstreamRecord } from '../src/types.js';

const upstream = (id: string): UpstreamRecord => ({
  id,
  provider: 'codex',
  name: id,
  enabled: true,
  sort_order: 0,
  created_at: '2026-06-21T00:00:00.000Z',
  updated_at: '2026-06-21T00:00:00.000Z',
  flag_overrides: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  config: {},
  state: null,
});

describe('parseNewKeyArgs', () => {
  const upstreams = [upstream('up_a'), upstream('up_b')];

  it('keeps multi-word names when no scope is present', () => {
    expect(parseNewKeyArgs('my test key', upstreams)).toEqual({
      name: 'my test key',
      upstreamIds: null,
    });
  });

  it('parses all scope', () => {
    expect(parseNewKeyArgs('my test key all', upstreams)).toEqual({
      name: 'my test key',
      upstreamIds: null,
    });
  });

  it('parses comma-scoped upstream ids', () => {
    expect(parseNewKeyArgs('my test key up_a,up_b', upstreams)).toEqual({
      name: 'my test key',
      upstreamIds: ['up_a', 'up_b'],
    });
  });

  it('rejects unknown scoped upstreams', () => {
    expect(parseNewKeyArgs('key up_missing', upstreams)).toEqual({
      error: 'Unknown upstream: up_missing',
    });
  });
});

describe('selectUpstream', () => {
  it('auto-selects when there is exactly one upstream and no id was provided', () => {
    const only = upstream('up_only');
    expect(selectUpstream('', [only], 'usage')).toEqual({ upstream: only });
  });

  it('asks for an upstream id when more than one upstream exists', () => {
    const selected = selectUpstream('', [upstream('up_a'), upstream('up_b')], 'upstream');
    expect('message' in selected ? selected.message : '').toContain('/upstream &lt;upstream_id&gt;');
    expect('message' in selected ? selected.message : '').toContain('<code>up_a</code>');
  });

  it('selects the requested upstream id', () => {
    const first = upstream('up_a');
    const second = upstream('up_b');
    expect(selectUpstream('up_b', [first, second], 'usage')).toEqual({ upstream: second });
  });
});
