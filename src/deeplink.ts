export const BIND_DEEPLINK_PREFIX = 'b_';
export const MAX_START_PAYLOAD_LENGTH = 64;

const START_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface BindDeepLinkCredentials {
  account: string;
  password: string;
}

export const encodeBindDeepLinkPayload = (account: string, password: string): string => {
  if (!account) throw new Error('account is required');
  if (!password) throw new Error('password is required');
  const encoded = Buffer.from(`${account}\n${password}`, 'utf8').toString('base64url');
  const payload = `${BIND_DEEPLINK_PREFIX}${encoded}`;
  if (payload.length > MAX_START_PAYLOAD_LENGTH) {
    throw new Error(`encoded payload is ${payload.length} chars; Telegram start payload limit is ${MAX_START_PAYLOAD_LENGTH}`);
  }
  if (!START_PAYLOAD_PATTERN.test(payload)) {
    throw new Error('encoded payload contains characters Telegram does not allow');
  }
  return payload;
};

export const decodeBindDeepLinkPayload = (payload: string): BindDeepLinkCredentials | null => {
  if (!payload.startsWith(BIND_DEEPLINK_PREFIX)) return null;
  if (!START_PAYLOAD_PATTERN.test(payload)) throw new Error('invalid Telegram start payload');
  const encoded = payload.slice(BIND_DEEPLINK_PREFIX.length);
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const separator = decoded.indexOf('\n');
  if (separator <= 0) throw new Error('bind payload is malformed');
  const account = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (!account || !password) throw new Error('bind payload is missing account or password');
  return { account, password };
};

export const buildBindDeepLink = (botUsername: string, account: string, password: string): string => {
  const username = botUsername.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('bot username is invalid');
  return `https://t.me/${username}?start=${encodeBindDeepLinkPayload(account, password)}`;
};
