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
let notifierStarted = false;
let launchPromise: Promise<void> | null = null;

const SHUTDOWN_LAUNCH_WAIT_TIMEOUT_MS = 5_000;

type TelegrafRuntimeState = {
  polling?: unknown;
  webhookServer?: unknown;
};

type BotRuntimeWaitResult = 'started' | 'settled' | 'timeout';

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
};

const isBotRuntimeStarted = (): boolean => {
  const runtime = bot as unknown as TelegrafRuntimeState;
  return runtime.polling !== undefined || runtime.webhookServer !== undefined;
};

const waitForBotRuntime = async (promise: Promise<void>): Promise<void> => {
  while (!isBotRuntimeStarted()) {
    const result = await Promise.race([
      promise.then(() => 'settled' as const),
      sleep(25).then(() => 'pending' as const),
    ]);
    if (result === 'settled' && !isBotRuntimeStarted()) {
      throw new Error('Telegram bot launch exited before polling/webhook runtime started');
    }
  }
};

const waitForBotRuntimeWithin = async (promise: Promise<void>, milliseconds: number): Promise<BotRuntimeWaitResult> => {
  return await Promise.race([
    waitForBotRuntime(promise).then(() => 'started' as const, () => 'settled' as const),
    sleep(milliseconds).then(() => 'timeout' as const),
  ]);
};

const waitForLaunchToSettleWithin = async (promise: Promise<void>, milliseconds: number): Promise<boolean> => {
  const result = await Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    sleep(milliseconds).then(() => 'timeout' as const),
  ]);
  return result === 'settled';
};

const startNotifier = (): void => {
  if (shuttingDown || notifierStarted) return;
  notifierStarted = true;
  secondaryWindowNotifier.start();
  console.log('Floway Telegram bot started');
};

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
  const notifierStopped = secondaryWindowNotifier.stop();
  if (launchPromise && !isBotRuntimeStarted()) {
    const runtimeWaitResult = await waitForBotRuntimeWithin(launchPromise, SHUTDOWN_LAUNCH_WAIT_TIMEOUT_MS);
    if (runtimeWaitResult === 'timeout') {
      console.warn('Telegram bot launch did not create a stoppable runtime before shutdown timeout');
    }
  }
  stopBot(signal);
  if (launchPromise) {
    const settled = await waitForLaunchToSettleWithin(launchPromise, SHUTDOWN_LAUNCH_WAIT_TIMEOUT_MS);
    if (!settled) {
      console.warn('Telegram bot launch did not settle before shutdown timeout');
    }
  }
  await notifierStopped;
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
  launchPromise = bot.launch();
  try {
    await waitForBotRuntime(launchPromise);
    if (shuttingDown) {
      stopBot('shutdown');
    } else {
      startNotifier();
    }
    await launchPromise;
  } catch (error) {
    if (!shuttingDown) {
      console.error('Floway Telegram bot launch failed:', error);
      process.exitCode = 1;
      await shutdown('launch-failed');
    }
  }
}
