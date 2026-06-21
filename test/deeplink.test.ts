import { describe, expect, it } from 'vitest';

import {
  buildBindDeepLink,
  decodeBindDeepLinkPayload,
  encodeBindDeepLinkPayload,
  MAX_START_PAYLOAD_LENGTH,
} from '../src/deeplink.js';

describe('bind deep links', () => {
  it('round-trips account and password through a Telegram-safe payload', () => {
    const payload = encodeBindDeepLinkPayload('3', 'short-pass');
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload.length).toBeLessThanOrEqual(MAX_START_PAYLOAD_LENGTH);
    expect(decodeBindDeepLinkPayload(payload)).toEqual({ account: '3', password: 'short-pass' });
  });

  it('builds a t.me link', () => {
    expect(buildBindDeepLink('@tracer_floway_bot', 'Tracer', 'pw')).toMatch(/^https:\/\/t[.]me\/tracer_floway_bot[?]start=b_/);
  });

  it('rejects oversized payloads', () => {
    expect(() => encodeBindDeepLinkPayload('Tracer', 'x'.repeat(80))).toThrow(/payload limit/);
  });

  it('ignores unrelated start payloads', () => {
    expect(decodeBindDeepLinkPayload('hello')).toBeNull();
  });
});
