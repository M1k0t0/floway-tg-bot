const SECRETISH_KEYS = new Set([
  'authorization',
  'password',
  'token',
  'key',
  'api_key',
  'apikey',
  'bearertoken',
  'githubtoken',
  'refresh_token',
  'access_token',
  'id_token',
]);

export const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    out[key] = SECRETISH_KEYS.has(normalized) || normalized.endsWith('token') || normalized.endsWith('key')
      ? '[redacted]'
      : redactValue(item);
  }
  return out;
};

export const redactText = (text: string, secrets: readonly string[] = []): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/("?(?:password|token|key|api_key|bearerToken|githubToken|refresh_token|access_token)"?\s*[:=]\s*)"[^"\s]+"/gi, '$1"[redacted]"')
    .replace(/(key=)[^&\s]+/gi, '$1[redacted]');
};
