import 'dotenv/config';

import { createBot, registerBotCommands } from './bot.js';
import { loadConfig } from './config.js';
import { BindingStore } from './db.js';
import { FlowayClient } from './floway-client.js';

const config = loadConfig();
const store = new BindingStore(config.botDbPath, config.botSecretKey);
const floway = new FlowayClient({
  baseUrl: config.flowayBaseUrl,
  adminKey: config.flowayAdminKey,
  usageExportCacheTtlSeconds: config.usageExportCacheTtlSeconds,
});

const bot = createBot(config, store, floway);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}, stopping bot`);
  bot.stop(signal);
  store.close();
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await registerBotCommands(bot);
await bot.launch();
console.log('Floway Telegram bot started');
