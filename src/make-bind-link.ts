import 'dotenv/config';

import { buildBindDeepLink } from './deeplink.js';
import { loadConfig } from './config.js';

const [account, password] = process.argv.slice(2);

if (!account || !password) {
  console.error('Usage: corepack pnpm bind-link <username-or-user-id> <password>');
  process.exit(1);
}

const config = loadConfig();
let botUsername = process.env.TELEGRAM_BOT_USERNAME;

if (!botUsername) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`);
  const body = await response.json() as { ok?: boolean; result?: { username?: string } };
  if (!response.ok || !body.ok || !body.result?.username) {
    throw new Error(`Telegram getMe failed: HTTP ${response.status}`);
  }
  botUsername = body.result.username;
}

console.log(buildBindDeepLink(botUsername, account, password));
