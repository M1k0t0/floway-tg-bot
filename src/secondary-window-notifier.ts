import { BindingStore, type SecondaryWindowState } from './db.js';
import { FlowayHttpError } from './floway-client.js';
import {
  formatQuotaEstimate,
  formatQuotaEstimateInsufficient,
  formatSecondaryWindowNotification,
  splitMessage,
} from './format.js';
import {
  canShareUpstreamQuota,
  computeWindowsFromQuota,
  hourString,
  summarizeUsageQuotaEstimate,
  summarizeUsageWindow,
  type UsageWindow,
} from './usage.js';
import type {
  AuthMeResponse,
  Binding,
  FlowayAdminUser,
  FlowayUser,
  SanitizedExportSnapshot,
  UpstreamRecord,
} from './types.js';

interface SecondaryWindowFlowayClient {
  listUpstreams(): Promise<UpstreamRecord[]>;
  listUsers(): Promise<FlowayAdminUser[]>;
  getMe(session: string): Promise<AuthMeResponse>;
  exportUsageSnapshot(): Promise<SanitizedExportSnapshot>;
}

interface TelegramSender {
  telegram: {
    sendMessage(chatId: string, text: string, extra: { parse_mode: 'HTML' }): Promise<unknown>;
  };
}

interface SecondaryWindowNotifierOptions {
  store: BindingStore;
  floway: SecondaryWindowFlowayClient;
  bot: TelegramSender;
  intervalSeconds: number;
}

interface NotificationCandidate {
  binding: Binding;
  upstream: UpstreamRecord;
  previousWindow: UsageWindow;
  currentWindow: UsageWindow;
  currentState: Omit<SecondaryWindowState, 'updatedAt'>;
}

export class SecondaryWindowNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly options: SecondaryWindowNotifierOptions) {}

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.options.intervalSeconds * 1000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
    } catch (error) {
      console.error('Secondary window notifier failed:', error);
    } finally {
      this.running = false;
    }
  }

  private async poll(): Promise<void> {
    const upstreams = await this.options.floway.listUpstreams();
    const candidates: NotificationCandidate[] = [];

    for (const binding of this.options.store.list()) {
      const bound = await this.refreshBinding(binding);
      if (!bound) continue;

      const allowedUpstreams = filterUsableUpstreamsForUser(upstreams, bound.user);
      this.options.store.deleteSecondaryWindowStatesExcept(
        bound.binding.telegramUserId,
        allowedUpstreams.map(upstream => upstream.id),
      );

      for (const upstream of allowedUpstreams) {
        const currentWindow = secondaryWindowForUpstream(upstream);
        if (!currentWindow) {
          this.options.store.deleteSecondaryWindowState(bound.binding.telegramUserId, upstream.id);
          continue;
        }

        const previous = this.options.store.getSecondaryWindowState(bound.binding.telegramUserId, upstream.id);
        const currentState = {
          telegramUserId: bound.binding.telegramUserId,
          upstreamId: upstream.id,
          windowStartAt: currentWindow.startAt,
          resetAfterAt: currentWindow.endAt,
          usedPercent: currentWindow.upstreamPercent ?? null,
        };

        if (previous && didWindowRefresh(previous, currentWindow)) {
          candidates.push({
            binding: bound.binding,
            upstream,
            previousWindow: windowFromState(previous),
            currentWindow,
            currentState,
          });
        } else {
          this.options.store.upsertSecondaryWindowState(currentState);
        }
      }
    }

    if (candidates.length === 0) return;
    const [snapshot, users] = await Promise.all([
      this.options.floway.exportUsageSnapshot(),
      this.options.floway.listUsers(),
    ]);
    for (const candidate of candidates) {
      try {
        await this.sendNotification(candidate, snapshot, users);
        this.options.store.upsertSecondaryWindowState(candidate.currentState);
      } catch (error) {
        console.error(`Failed to send secondary window notification to Telegram user ${candidate.binding.telegramUserId}:`, error);
      }
    }
  }

  private async refreshBinding(binding: Binding): Promise<{ binding: Binding; user: FlowayUser } | null> {
    try {
      const me = await this.options.floway.getMe(binding.flowaySession);
      let currentBinding = binding;
      if (me.user.id !== binding.flowayUserId || me.user.username !== binding.username) {
        currentBinding = this.options.store.upsert({
          telegramUserId: binding.telegramUserId,
          flowayUserId: me.user.id,
          username: me.user.username,
          flowaySession: binding.flowaySession,
        });
      }
      return { binding: currentBinding, user: me.user };
    } catch (error) {
      if (error instanceof FlowayHttpError && error.status === 401) {
        this.options.store.delete(binding.telegramUserId);
        return null;
      }
      console.error(`Failed to refresh Floway binding for Telegram user ${binding.telegramUserId}:`, error);
      return null;
    }
  }

  private async sendNotification(
    candidate: NotificationCandidate,
    snapshot: SanitizedExportSnapshot,
    users: readonly FlowayAdminUser[],
  ): Promise<void> {
    const report = summarizeUsageWindow(
      candidate.binding.flowayUserId,
      candidate.upstream.id,
      candidate.previousWindow,
      snapshot,
    );
    const quotaEstimate = formatCurrentQuotaEstimate(candidate, snapshot, users);
    const text = formatSecondaryWindowNotification(candidate.upstream, report, quotaEstimate);
    for (const chunk of splitMessage(text)) {
      await this.options.bot.telegram.sendMessage(candidate.binding.telegramUserId, chunk, { parse_mode: 'HTML' });
    }
  }
}

const filterUsableUpstreamsForUser = (
  upstreams: readonly UpstreamRecord[],
  user: Pick<FlowayUser, 'upstreamIds'>,
): UpstreamRecord[] => {
  const allowed = user.upstreamIds === null
    ? upstreams
    : upstreams.filter(upstream => user.upstreamIds?.includes(upstream.id));
  return allowed.filter(upstream => upstream.enabled);
};

const secondaryWindowForUpstream = (upstream: UpstreamRecord): UsageWindow | null =>
  computeWindowsFromQuota(upstream.codex_quota).find(window => window.label === 'Secondary window') ?? null;

const formatCurrentQuotaEstimate = (
  candidate: NotificationCandidate,
  snapshot: SanitizedExportSnapshot,
  users: readonly FlowayAdminUser[],
): string => {
  const upstreamUsedPercent = candidate.upstream.codex_quota?.secondary_used_percent;
  if (upstreamUsedPercent === undefined) return formatQuotaEstimate(candidate.upstream, null);
  if (upstreamUsedPercent < 1) {
    return formatQuotaEstimateInsufficient(
      candidate.upstream,
      candidate.currentWindow.startAt,
      candidate.currentWindow.endAt,
      upstreamUsedPercent,
    );
  }

  const nonAdminUserCount = users.filter(user => canShareUpstreamQuota(user, candidate.upstream.id)).length;
  const report = summarizeUsageQuotaEstimate(
    candidate.binding.flowayUserId,
    candidate.upstream.id,
    candidate.currentWindow,
    upstreamUsedPercent,
    snapshot,
    nonAdminUserCount,
  );
  return formatQuotaEstimate(candidate.upstream, report);
};

const didWindowRefresh = (previous: SecondaryWindowState, current: UsageWindow): boolean => {
  const previousEnd = new Date(previous.resetAfterAt).getTime();
  const currentEnd = new Date(current.endAt).getTime();
  return Number.isFinite(previousEnd) && Number.isFinite(currentEnd) && currentEnd > previousEnd;
};

const windowFromState = (state: SecondaryWindowState): UsageWindow => {
  const window: UsageWindow = {
    label: 'Secondary window',
    startAt: state.windowStartAt,
    endAt: state.resetAfterAt,
    startHour: hourString(new Date(state.windowStartAt)),
    endHour: hourString(new Date(state.resetAfterAt)),
  };
  if (state.usedPercent !== null) window.upstreamPercent = state.usedPercent;
  return window;
};
