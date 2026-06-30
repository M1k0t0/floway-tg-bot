import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

import { BindingStore } from './db.js';
import { decodeBindDeepLinkPayload } from './deeplink.js';
import {
  formatBinding,
  formatBindDeepLinkSuccess,
  formatCreatedKey,
  formatInfo,
  formatKeys,
  formatQuotaEstimate,
  formatQuotaEstimateInsufficient,
  formatQuotaEstimateInsufficientNotification,
  formatQuotaEstimateNotification,
  formatQuotaEstimateVerbose,
  formatSecondaryWindowNotification,
  formatStartHelp,
  formatUpstreamDetail,
  formatUpstreamList,
  formatUpstreamSelectionRequired,
  formatUsageLeaderboard,
  formatUsageReports,
  splitMessage,
} from './format.js';
import { FlowayClient, FlowayHttpError } from './floway-client.js';
import {
  canShareUpstreamQuota,
  computeWindowsForUpstream,
  summarizeUsageLeaderboard,
  summarizeUsageQuotaEstimate,
  summarizeUsageWindow,
  type LeaderboardDays,
  type UsageWindowReport,
} from './usage.js';
import type { AppConfig, Binding, FlowayUser, UpstreamRecord } from './types.js';

export { canShareUpstreamQuota } from './usage.js';

export const TEST_SECONDARY_WINDOW_COMMAND = 'test_secondary_window';

export const BOT_COMMANDS = [
  { command: 'start', description: 'Show bot usage help' },
  { command: 'bind', description: 'Bind Floway account' },
  { command: 'unbind', description: 'Remove Floway binding' },
  { command: 'me', description: 'Show bound Floway user' },
  { command: 'info', description: 'Show API endpoints and key usage info' },
  { command: 'upstreams', description: 'List Floway upstreams' },
  { command: 'upstream', description: 'Show upstream detail' },
  { command: 'keys', description: 'List your Floway API keys' },
  { command: 'newkey', description: 'Create API key' },
  { command: 'delkey', description: 'Delete API key' },
  { command: 'rotatekey', description: 'Rotate API key' },
  { command: 'usage', description: 'Show upstream usage' },
  { command: 'quota', description: 'Show estimated upstream quota' },
  { command: 'leaderboard', description: 'Show usage leaderboard' },
] as const;

export const registerBotCommands = async (bot: Telegraf): Promise<void> => {
  await bot.telegram.setMyCommands([...BOT_COMMANDS]);
};

interface BoundFlowaySession {
  binding: Binding;
  user: FlowayUser;
}

export const createBot = (config: AppConfig, store: BindingStore, floway: FlowayClient): Telegraf => {
  const bot = new Telegraf(config.telegramBotToken);

  bot.start(async ctx => {
    const payload = commandArgs(ctx);
    if (payload) {
      const handled = await handleStartPayload(ctx, store, floway, payload);
      if (handled) return;
    }
    if (!(await requirePrivate(ctx))) return;
    await replyLong(ctx, formatStartHelp(store.get(telegramUserId(ctx))));
  });

  bot.command('bind', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const args = commandArgs(ctx);
    const firstSpace = args.search(/\s/);
    if (!args || firstSpace < 0) {
      await ctx.reply('Usage: /bind <username> <password>');
      return;
    }
    const username = args.slice(0, firstSpace).trim();
    const password = args.slice(firstSpace).trim();
    if (!username || !password) {
      await ctx.reply('Usage: /bind <username> <password>');
      return;
    }

    try {
      const login = await floway.login(username, password);
      store.upsert({
        telegramUserId: telegramUserId(ctx),
        flowayUserId: login.user.id,
        username: login.user.username,
        flowaySession: login.token,
      });
      await bestEffortDeleteMessage(ctx);
      await ctx.reply(`Bound Floway user ${login.user.username}.`);
    } catch (error) {
      await replyError(ctx, 'Bind failed', error);
    }
  });

  bot.command('unbind', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const existing = store.get(telegramUserId(ctx));
    if (existing) {
      await floway.logout(existing.flowaySession).catch(() => undefined);
    }
    const deleted = store.delete(telegramUserId(ctx));
    await ctx.reply(deleted ? 'Binding removed.' : 'No binding found.');
  });

  bot.command('me', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    await replyLong(ctx, formatBinding(bound.binding));
  });

  bot.command('info', async ctx => {
    await replyLong(ctx, formatInfo(config.flowayBaseUrl));
  });

  bot.command('upstreams', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    try {
      const upstreams = filterUpstreamsForUser(await floway.listUpstreams(), bound.user);
      await replyLong(ctx, formatUpstreamList(upstreams));
    } catch (error) {
      await replyError(ctx, 'Failed to load upstreams', error);
    }
  });

  bot.command('upstream', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const id = commandArgs(ctx).trim();
    try {
      const upstreams = filterUpstreamsForUser(await floway.listUpstreams(), bound.user);
      const selection = selectUpstream(id, upstreams, 'upstream');
      if ('message' in selection) {
        await replyLong(ctx, selection.message);
        return;
      }
      const upstream = selection.upstream;
      const [models, copilotQuota] = await Promise.all([
        floway.getUpstreamModels(upstream.id),
        upstream.provider === 'copilot'
          ? floway.getCopilotQuota(upstream.id).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
          : Promise.resolve(null),
      ]);
      await replyLong(ctx, formatUpstreamDetail(upstream, models.data, copilotQuota));
    } catch (error) {
      await replyError(ctx, 'Failed to load upstream detail', error);
    }
  });

  bot.command('keys', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    try {
      const keys = await floway.listKeys(bound.binding.flowaySession);
      await replyLong(ctx, formatKeys(keys));
    } catch (error) {
      await replyError(ctx, 'Failed to load keys', error);
    }
  });

  bot.command('newkey', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const args = commandArgs(ctx).trim();
    if (!args) {
      await ctx.reply('Usage: /newkey <name> [all|upstream_id[,upstream_id...]]');
      return;
    }

    try {
      const upstreams = filterUpstreamsForUser(await floway.listUpstreams(), bound.user);
      const parsed = parseNewKeyArgs(args, upstreams);
      if ('error' in parsed) {
        await ctx.reply(parsed.error);
        return;
      }
      const key = await floway.createKey(bound.binding.flowaySession, parsed.name, parsed.upstreamIds);
      await replyLong(ctx, formatCreatedKey(key, 'created'));
    } catch (error) {
      await replyError(ctx, 'Failed to create key', error);
    }
  });

  bot.command('delkey', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const id = commandArgs(ctx).trim();
    if (!id) {
      await ctx.reply('Usage: /delkey <key_id>');
      return;
    }
    try {
      await floway.deleteKey(bound.binding.flowaySession, id);
      await ctx.reply(`Deleted key ${id}.`);
    } catch (error) {
      await replyError(ctx, 'Failed to delete key', error);
    }
  });

  bot.command('rotatekey', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const id = commandArgs(ctx).trim();
    if (!id) {
      await ctx.reply('Usage: /rotatekey <key_id>');
      return;
    }
    try {
      const key = await floway.rotateKey(bound.binding.flowaySession, id);
      await replyLong(ctx, formatCreatedKey(key, 'rotated'));
    } catch (error) {
      await replyError(ctx, 'Failed to rotate key', error);
    }
  });

  bot.command('usage', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const upstreamId = commandArgs(ctx).trim();

    try {
      const upstreams = filterUpstreamsForUser(await floway.listUpstreams(), bound.user);
      const selection = selectUpstream(upstreamId, upstreams, 'usage');
      if ('message' in selection) {
        await replyLong(ctx, selection.message);
        return;
      }
      const upstream = selection.upstream;

      const windows = computeWindowsForUpstream(upstream);
      if (windows.length === 0) {
        await replyLong(ctx, formatUsageReports(upstream, []));
        return;
      }

      const exportSnapshot = await floway.exportUsageSnapshot();
      const reports: UsageWindowReport[] = windows.map(window =>
        summarizeUsageWindow(bound.binding.flowayUserId, upstream.id, window, exportSnapshot));
      await replyLong(ctx, formatUsageReports(upstream, reports));
    } catch (error) {
      await replyError(ctx, 'Failed to load usage', error);
    }
  });

  bot.command('quota', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const parsed = parseQuotaArgs(commandArgs(ctx));
    if ('error' in parsed) {
      await ctx.reply(parsed.error);
      return;
    }

    try {
      const [upstreams, users] = await Promise.all([
        floway.listUpstreams(),
        floway.listUsers(),
      ]);
      const allowedUpstreams = filterUpstreamsForUser(upstreams, bound.user);
      const selection = selectUpstream(parsed.upstreamId, allowedUpstreams, parsed.verbose ? 'quota verbose' : 'quota');
      if ('message' in selection) {
        await replyLong(ctx, selection.message);
        return;
      }
      const upstream = selection.upstream;
      const secondaryWindow = computeWindowsForUpstream(upstream)
        .find(window => window.label === 'Secondary window') ?? null;
      const secondaryUsedPercent = secondaryWindow?.upstreamPercent;
      if (!secondaryWindow || secondaryUsedPercent === undefined) {
        await replyLong(ctx, formatQuotaEstimate(upstream, null));
        return;
      }
      if (secondaryUsedPercent < 1) {
        await replyLong(ctx, formatQuotaEstimateInsufficient(upstream, secondaryWindow.startAt, secondaryWindow.endAt, secondaryUsedPercent));
        return;
      }

      const exportSnapshot = await floway.exportUsageSnapshot();
      const nonAdminUserCount = users.filter(user => canShareUpstreamQuota(user, upstream.id)).length;
      const report = summarizeUsageQuotaEstimate(
        bound.binding.flowayUserId,
        upstream.id,
        secondaryWindow,
        secondaryUsedPercent,
        exportSnapshot,
        nonAdminUserCount,
      );
      await replyLong(ctx, parsed.verbose ? formatQuotaEstimateVerbose(upstream, report) : formatQuotaEstimate(upstream, report));
    } catch (error) {
      await replyError(ctx, 'Failed to load quota estimate', error);
    }
  });

  bot.command('leaderboard', async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const parsed = parseLeaderboardArgs(commandArgs(ctx));
    if ('error' in parsed) {
      await ctx.reply(parsed.error);
      return;
    }
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;

    try {
      if (!canViewLeaderboard(bound.user)) {
        await ctx.reply('Global telemetry access is required to view the leaderboard.');
        return;
      }
      const exportSnapshot = await floway.exportUsageSnapshot();
      await replyLong(ctx, formatUsageLeaderboard(summarizeUsageLeaderboard(exportSnapshot, parsed.days, 4, new Date(), bound.user.upstreamIds)));
    } catch (error) {
      await replyError(ctx, 'Failed to load leaderboard', error);
    }
  });

  bot.command(TEST_SECONDARY_WINDOW_COMMAND, async ctx => {
    if (!(await requirePrivate(ctx))) return;
    const bound = await requireBinding(ctx, store, floway);
    if (!bound) return;
    const upstreamId = commandArgs(ctx).trim();

    try {
      const [upstreams, users] = await Promise.all([
        floway.listUpstreams(),
        floway.listUsers(),
      ]);
      const allowedUpstreams = filterUpstreamsForUser(upstreams, bound.user).filter(upstream => upstream.enabled);
      const selection = selectUpstream(upstreamId, allowedUpstreams, TEST_SECONDARY_WINDOW_COMMAND);
      if ('message' in selection) {
        await replyLong(ctx, selection.message);
        return;
      }

      const upstream = selection.upstream;
      const secondaryWindow = computeWindowsForUpstream(upstream)
        .find(window => window.label === 'Secondary window') ?? null;
      if (!secondaryWindow) {
        await replyLong(ctx, formatQuotaEstimate(upstream, null));
        return;
      }

      const exportSnapshot = await floway.exportUsageSnapshot();
      const usageReport = summarizeUsageWindow(
        bound.binding.flowayUserId,
        upstream.id,
        secondaryWindow,
        exportSnapshot,
      );
      const secondaryUsedPercent = secondaryWindow.upstreamPercent;
      const quotaEstimate = formatSecondaryWindowQuotaEstimate(
        bound.binding.flowayUserId,
        upstream,
        secondaryWindow,
        secondaryUsedPercent,
        exportSnapshot,
        users,
      );
      await replyLong(ctx, [
        '<b>Test notification</b>',
        formatSecondaryWindowNotification(upstream, usageReport, quotaEstimate),
      ].join('\n'));
    } catch (error) {
      await replyError(ctx, 'Failed to send secondary window test notification', error);
    }
  });

  bot.catch((error, ctx) => {
    console.error('Unhandled Telegram update error:', error);
    void ctx.reply('Internal bot error. Check bot logs.').catch(() => undefined);
  });

  return bot;
};

const handleStartPayload = async (
  ctx: Context,
  store: BindingStore,
  floway: FlowayClient,
  payload: string,
): Promise<boolean> => {
  let credentials;
  try {
    credentials = decodeBindDeepLinkPayload(payload);
  } catch (error) {
    await bestEffortDeleteMessage(ctx);
    await replyError(ctx, 'Invalid bind link', error);
    return true;
  }
  if (!credentials) return false;
  if (!(await requirePrivate(ctx))) return true;

  try {
    const username = await resolveLoginUsername(floway, credentials.account);
    const login = await floway.login(username, credentials.password);
    store.upsert({
      telegramUserId: telegramUserId(ctx),
      flowayUserId: login.user.id,
      username: login.user.username,
      flowaySession: login.token,
    });
    await bestEffortDeleteMessage(ctx);
    await replyLong(ctx, formatBindDeepLinkSuccess(login.user.username, credentials.password));
  } catch (error) {
    await bestEffortDeleteMessage(ctx);
    await replyError(ctx, 'Bind link failed', error);
  }
  return true;
};

const resolveLoginUsername = async (floway: FlowayClient, account: string): Promise<string> => {
  if (!/^\d+$/.test(account)) return account;
  const users = await floway.listUsers();
  return users.find(user => user.id === Number(account))?.username ?? account;
};

const requirePrivate = async (ctx: Context): Promise<boolean> => {
  if (ctx.chat?.type === 'private') return true;
  await ctx.reply('Please DM this bot for binding, key management, and usage commands.');
  return false;
};

const telegramUserId = (ctx: Context): string => {
  if (!ctx.from) throw new Error('Telegram update has no sender');
  return String(ctx.from.id);
};

const commandArgs = (ctx: Context): string => {
  const message = ctx.message;
  const text = message && 'text' in message && typeof message.text === 'string' ? message.text : '';
  return text.replace(/^\/[^\s]+(?:\s+)?/, '').trim();
};

const requireBinding = async (ctx: Context, store: BindingStore, floway: FlowayClient): Promise<BoundFlowaySession | null> => {
  const binding = store.get(telegramUserId(ctx));
  if (!binding) {
    await ctx.reply('Not bound. Use /bind <username> <password> in this private chat.');
    return null;
  }
  try {
    const me = await floway.getMe(binding.flowaySession);
    let currentBinding = binding;
    if (me.user.id !== binding.flowayUserId || me.user.username !== binding.username) {
      currentBinding = store.upsert({
        telegramUserId: binding.telegramUserId,
        flowayUserId: me.user.id,
        username: me.user.username,
        flowaySession: binding.flowaySession,
      });
    }
    return { binding: currentBinding, user: me.user };
  } catch (error) {
    if (error instanceof FlowayHttpError && error.status === 401) {
      store.delete(telegramUserId(ctx));
      await ctx.reply('Floway session expired. Bind again with /bind <username> <password>.');
      return null;
    }
    throw error;
  }
};

const replyLong = async (ctx: Context, text: string): Promise<void> => {
  for (const chunk of splitMessage(text)) await ctx.reply(chunk, { parse_mode: 'HTML' });
};

const replyError = async (ctx: Context, prefix: string, error: unknown): Promise<void> => {
  const suffix = error instanceof Error ? error.message : String(error);
  await ctx.reply(`${prefix}: ${suffix}`);
};

const bestEffortDeleteMessage = async (ctx: Context): Promise<void> => {
  await ctx.deleteMessage().catch(() => undefined);
};

export const parseNewKeyArgs = (
  args: string,
  upstreams: readonly UpstreamRecord[],
): { name: string; upstreamIds: string[] | null } | { error: string } => {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { error: 'Usage: /newkey <name> [all|upstream_id[,upstream_id...]]' };

  const known = new Set(upstreams.map(upstream => upstream.id));
  const last = tokens[tokens.length - 1]!;
  let name = args;
  let upstreamIds: string[] | null = null;
  let scoped = false;

  if (last === 'all') {
    scoped = true;
    upstreamIds = null;
  } else if (last.includes(',') || known.has(last) || (tokens.length > 1 && last.startsWith('up_'))) {
    scoped = true;
    upstreamIds = last.split(',').map(item => item.trim()).filter(Boolean);
  }

  if (scoped) {
    name = tokens.slice(0, -1).join(' ');
    if (!name) return { error: 'Key name is required before the upstream scope.' };
  }

  if (upstreamIds !== null) {
    const seen = new Set<string>();
    for (const id of upstreamIds) {
      if (!known.has(id)) return { error: `Unknown upstream: ${id}` };
      if (seen.has(id)) return { error: `Duplicate upstream: ${id}` };
      seen.add(id);
    }
    if (upstreamIds.length === 0) return { error: 'Select at least one upstream or use all.' };
  }

  return { name, upstreamIds };
};

export const parseLeaderboardArgs = (args: string): { days: LeaderboardDays } | { error: string } => {
  const normalized = args.trim().toLowerCase();
  if (normalized === '1' || normalized === '1d') return { days: 1 };
  if (!normalized || normalized === '7' || normalized === '7d') return { days: 7 };
  if (normalized === '30' || normalized === '30d') return { days: 30 };
  return { error: 'Usage: /leaderboard [1d|7d|30d]' };
};

export const parseQuotaArgs = (args: string): { upstreamId: string; verbose: boolean } | { error: string } => {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { upstreamId: '', verbose: false };
  if (tokens[0] === 'verbose') {
    if (tokens.length > 2) return { error: 'Usage: /quota [verbose] <upstream_id>' };
    return { upstreamId: tokens[1] ?? '', verbose: true };
  }
  if (tokens.length > 1) return { error: 'Usage: /quota [verbose] <upstream_id>' };
  return { upstreamId: tokens[0]!, verbose: false };
};

export const canViewLeaderboard = (user: Pick<FlowayUser, 'canViewGlobalTelemetry'>): boolean =>
  user.canViewGlobalTelemetry;

export const filterUpstreamsForUser = (
  upstreams: readonly UpstreamRecord[],
  user: Pick<FlowayUser, 'upstreamIds'>,
): UpstreamRecord[] => {
  if (user.upstreamIds === null) return [...upstreams];
  const allowed = new Set(user.upstreamIds);
  return upstreams.filter(upstream => allowed.has(upstream.id));
};

export const selectUpstream = (
  requestedId: string,
  upstreams: readonly UpstreamRecord[],
  command: 'upstream' | 'usage' | 'quota' | 'quota verbose' | typeof TEST_SECONDARY_WINDOW_COMMAND,
): { upstream: UpstreamRecord } | { message: string } => {
  if (requestedId) {
    const upstream = upstreams.find(item => item.id === requestedId);
    return upstream
      ? { upstream }
      : { message: `Upstream not found: ${htmlSafeText(requestedId)}` };
  }
  if (upstreams.length === 1) return { upstream: upstreams[0]! };
  return { message: formatUpstreamSelectionRequired(command, upstreams) };
};

const formatSecondaryWindowQuotaEstimate = (
  flowayUserId: number,
  upstream: UpstreamRecord,
  secondaryWindow: NonNullable<ReturnType<typeof computeWindowsForUpstream>[number]>,
  secondaryUsedPercent: number | undefined,
  exportSnapshot: Parameters<typeof summarizeUsageWindow>[3],
  users: Awaited<ReturnType<FlowayClient['listUsers']>>,
): string => {
  if (secondaryUsedPercent === undefined) return formatQuotaEstimateNotification(null);
  if (secondaryUsedPercent < 1) return formatQuotaEstimateInsufficientNotification(secondaryUsedPercent);

  const nonAdminUserCount = users.filter(user => canShareUpstreamQuota(user, upstream.id)).length;
  const report = summarizeUsageQuotaEstimate(
    flowayUserId,
    upstream.id,
    secondaryWindow,
    secondaryUsedPercent,
    exportSnapshot,
    nonAdminUserCount,
  );
  return formatQuotaEstimateNotification(report);
};

const htmlSafeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
