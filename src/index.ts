import 'dotenv/config';

import { createBot, registerBotCommands } from './bot.js';
import { loadConfig } from './config.js';
import { BindingStore } from './db.js';
import { FlowayClient } from './floway-client.js';
import { SecondaryWindowNotifier } from './secondary-window-notifier.js';

const config = loadConfig();
const store = new BindingStore(config.botDbPath, config.botSecretKey);
const floway = new FlowayClient({
  baseUrl: config.flowayBaseUrl,
  adminKey: config.flowayAdminKey,
  usageExportCacheTtlSeconds: config.usageExportCacheTtlSeconds,
});

const bot = createBot(config, store, floway);
const secondaryWindowNotifier = new SecondaryWindowNotifier({
  store,
  floway,
  bot,
  intervalSeconds: config.secondaryWindowNotifyIntervalSeconds,
});

let shuttingDown = false;
let storeClosed = false;

const stopBot = (signal: string): void => {
  try {
    bot.stop(signal);
  } catch (error) {
    if (!(error instanceof Error && error.message === 'Bot is not running!')) throw error;
  }
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, stopping bot`);
  secondaryWindowNotifier.stop();
  stopBot(signal);
  if (!storeClosed) {
    store.close();
    storeClosed = true;
  }
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

if (!shuttingDown) await registerBotCommands(bot);
if (!shuttingDown) {
  await bot.launch();
}
if (shuttingDown) {
  stopBot('shutdown');
} else {
  secondaryWindowNotifier.start();
  console.log('Floway Telegram bot started');
}
