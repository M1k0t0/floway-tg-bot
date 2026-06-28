import { BindingStore, type SecondaryWindowState } from './db.js';
import { FlowayHttpError } from './floway-client.js';
import {
  formatQuotaEstimateInsufficientNotification,
  formatQuotaEstimateNotification,
  formatSecondaryWindowNotification,
  splitMessage,
} from './format.js';
import {
  canShareUpstreamQuota,
  computeWindowsForUpstream,
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

interface WindowRefresh {
  previousWindow: UsageWindow;
  currentWindow: UsageWindow;
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
        const previous = this.options.store.getSecondaryWindowState(bound.binding.telegramUserId, upstream.id);
        const currentWindow = secondaryWindowForUpstream(upstream);
        if (!currentWindow) {
          if (!canUseMissingCodexQuotaState(upstream)) {
            this.options.store.deleteSecondaryWindowState(bound.binding.telegramUserId, upstream.id);
            continue;
          }
          const elapsed = previous ? elapsedWindowRefreshFromState(previous) : null;
          if (elapsed) {
            this.enqueueOrApplySentNotification(candidates, {
              binding: bound.binding,
              upstream,
              previousWindow: elapsed.previousWindow,
              currentWindow: elapsed.currentWindow,
              currentState: windowState(bound.binding, upstream.id, elapsed.currentWindow, null),
            });
          }
          continue;
        }

        const currentState = windowState(bound.binding, upstream.id, currentWindow, currentWindow.upstreamPercent ?? null);

        if (previous && didWindowRefresh(previous, currentWindow)) {
          const previousWindow = windowToReport(previous, currentWindow);
          this.enqueueOrApplySentNotification(candidates, {
            binding: bound.binding,
            upstream,
            previousWindow,
            currentWindow,
            currentState,
          });
        } else if (previous) {
          const elapsed = elapsedWindowRefreshFromState(previous);
          if (elapsed) {
            this.enqueueOrApplySentNotification(candidates, {
              binding: bound.binding,
              upstream,
              previousWindow: elapsed.previousWindow,
              currentWindow: elapsed.currentWindow,
              currentState: windowState(bound.binding, upstream.id, elapsed.currentWindow, null),
            });
          } else {
            const storedWindow = windowFromState(previous);
            const previousWindow = shouldBackfillCompletedWindow(bound.binding, storedWindow)
              ? completedWindowBefore(storedWindow)
              : null;
            if (previousWindow) {
              const storedWindowMatchesCurrent = isSameWindow(storedWindow, currentWindow);
              this.enqueueOrApplySentNotification(candidates, {
                binding: bound.binding,
                upstream,
                previousWindow,
                currentWindow: storedWindowMatchesCurrent ? currentWindow : storedWindow,
                currentState: storedWindowMatchesCurrent
                  ? currentState
                  : windowState(bound.binding, upstream.id, storedWindow, previous.usedPercent),
              });
            } else if (isWindowAtLeast(previous, currentWindow)) {
              this.options.store.upsertSecondaryWindowState(currentState);
            }
          }
        } else {
          const elapsed = elapsedWindowRefresh(currentWindow, new Date());
          if (elapsed) {
            const elapsedState = windowState(bound.binding, upstream.id, elapsed.currentWindow, null);
            if (wasBoundBeforeWindowEnded(bound.binding, elapsed.previousWindow)) {
              this.enqueueOrApplySentNotification(candidates, {
                binding: bound.binding,
                upstream,
                previousWindow: elapsed.previousWindow,
                currentWindow: elapsed.currentWindow,
                currentState: elapsedState,
              });
            } else {
              this.options.store.upsertSecondaryWindowState(elapsedState);
            }
          } else if (shouldCatchUpMissingState(bound.binding, currentWindow)) {
            const previousWindow = completedWindowBefore(currentWindow);
            if (previousWindow) {
              this.enqueueOrApplySentNotification(candidates, {
                binding: bound.binding,
                upstream,
                previousWindow,
                currentWindow,
                currentState,
              });
            } else {
              this.options.store.upsertSecondaryWindowState(currentState);
            }
          } else {
            this.options.store.upsertSecondaryWindowState(currentState);
          }
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
        this.options.store.upsertSecondaryWindowNotification({
          telegramUserId: candidate.binding.telegramUserId,
          upstreamId: candidate.upstream.id,
          windowStartAt: candidate.previousWindow.startAt,
          resetAfterAt: candidate.previousWindow.endAt,
        });
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
    const quotaEstimate = formatPreviousQuotaEstimate(candidate, snapshot, users);
    const text = formatSecondaryWindowNotification(candidate.upstream, report, quotaEstimate);
    for (const chunk of splitMessage(text)) {
      await this.options.bot.telegram.sendMessage(candidate.binding.telegramUserId, chunk, { parse_mode: 'HTML' });
    }
  }

  private enqueueOrApplySentNotification(candidates: NotificationCandidate[], candidate: NotificationCandidate): void {
    const sent = this.options.store.getSecondaryWindowNotification(
      candidate.binding.telegramUserId,
      candidate.upstream.id,
      candidate.previousWindow.startAt,
      candidate.previousWindow.endAt,
    );
    if (!sent) {
      candidates.push(candidate);
      return;
    }
    this.options.store.upsertSecondaryWindowState(candidate.currentState);
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
  computeWindowsForUpstream(upstream).find(window => window.label === 'Secondary window') ?? null;

const canUseMissingCodexQuotaState = (upstream: UpstreamRecord): boolean =>
  upstream.provider === 'codex' && !upstream.codex_quota;

const formatPreviousQuotaEstimate = (
  candidate: NotificationCandidate,
  snapshot: SanitizedExportSnapshot,
  users: readonly FlowayAdminUser[],
): string => {
  const upstreamUsedPercent = candidate.previousWindow.upstreamPercent;
  if (upstreamUsedPercent === undefined) return formatQuotaEstimateNotification(null);
  if (upstreamUsedPercent < 1) {
    return formatQuotaEstimateInsufficientNotification(upstreamUsedPercent);
  }

  const nonAdminUserCount = users.filter(user => canShareUpstreamQuota(user, candidate.upstream.id)).length;
  const report = summarizeUsageQuotaEstimate(
    candidate.binding.flowayUserId,
    candidate.upstream.id,
    candidate.previousWindow,
    upstreamUsedPercent,
    snapshot,
    nonAdminUserCount,
  );
  return formatQuotaEstimateNotification(report);
};

const didWindowRefresh = (previous: SecondaryWindowState, current: UsageWindow): boolean => {
  const previousEnd = new Date(previous.resetAfterAt).getTime();
  const currentEnd = new Date(current.endAt).getTime();
  return Number.isFinite(previousEnd) && Number.isFinite(currentEnd) && currentEnd > previousEnd;
};

const isWindowAtLeast = (previous: SecondaryWindowState, current: UsageWindow): boolean => {
  const previousEnd = new Date(previous.resetAfterAt).getTime();
  const currentEnd = new Date(current.endAt).getTime();
  return Number.isFinite(previousEnd) && Number.isFinite(currentEnd) && currentEnd >= previousEnd;
};

const isSameWindow = (left: UsageWindow, right: UsageWindow): boolean =>
  left.startAt === right.startAt && left.endAt === right.endAt;

const windowToReport = (previous: SecondaryWindowState, current: UsageWindow): UsageWindow => {
  const completed = completedWindowBefore(current);
  if (!completed) return windowFromState(previous);

  const previousEnd = new Date(previous.resetAfterAt).getTime();
  const completedEnd = new Date(completed.endAt).getTime();
  if (Number.isFinite(previousEnd) && Number.isFinite(completedEnd) && completedEnd > previousEnd) {
    return completed;
  }
  return windowFromState(previous);
};

const elapsedWindowRefreshFromState = (previous: SecondaryWindowState, now = new Date()): WindowRefresh | null =>
  elapsedWindowRefresh(windowFromState(previous), now);

const elapsedWindowRefresh = (knownWindow: UsageWindow, now: Date): WindowRefresh | null => {
  const start = new Date(knownWindow.startAt);
  const end = new Date(knownWindow.endAt);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const nowMs = now.getTime();
  const durationMs = endMs - startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(nowMs) || durationMs <= 0 || nowMs < endMs) {
    return null;
  }

  const elapsedCompletedWindows = Math.floor((nowMs - endMs) / durationMs);
  const previousStart = new Date(startMs + elapsedCompletedWindows * durationMs);
  const previousEnd = new Date(endMs + elapsedCompletedWindows * durationMs);
  const currentEnd = new Date(previousEnd.getTime() + durationMs);
  return {
    previousWindow: {
      label: knownWindow.label,
      startAt: previousStart.toISOString(),
      endAt: previousEnd.toISOString(),
      startHour: hourString(previousStart),
      endHour: hourString(previousEnd),
      ...(elapsedCompletedWindows === 0 && knownWindow.upstreamPercent !== undefined ? { upstreamPercent: knownWindow.upstreamPercent } : {}),
    },
    currentWindow: {
      label: knownWindow.label,
      startAt: previousEnd.toISOString(),
      endAt: currentEnd.toISOString(),
      startHour: hourString(previousEnd),
      endHour: hourString(currentEnd),
    },
  };
};

const shouldBackfillCompletedWindow = (binding: Pick<Binding, 'createdAt'>, currentWindow: UsageWindow, now = new Date()): boolean => {
  const currentStart = new Date(currentWindow.startAt).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(currentStart) || !Number.isFinite(nowMs) || currentStart > nowMs) return false;
  const previousWindow = completedWindowBefore(currentWindow);
  return previousWindow !== null && wasBoundBeforeWindowEnded(binding, previousWindow);
};

const shouldCatchUpMissingState = (binding: Pick<Binding, 'createdAt'>, current: UsageWindow, now = new Date()): boolean => {
  const bindingCreated = new Date(binding.createdAt).getTime();
  const currentStart = new Date(current.startAt).getTime();
  const nowMs = now.getTime();
  return Number.isFinite(bindingCreated)
    && Number.isFinite(currentStart)
    && Number.isFinite(nowMs)
    && bindingCreated < currentStart
    && currentStart <= nowMs;
};

const wasBoundBeforeWindowEnded = (binding: Pick<Binding, 'createdAt'>, window: UsageWindow): boolean => {
  const bindingCreated = new Date(binding.createdAt).getTime();
  const windowEnd = new Date(window.endAt).getTime();
  return Number.isFinite(bindingCreated) && Number.isFinite(windowEnd) && bindingCreated < windowEnd;
};

const completedWindowBefore = (current: UsageWindow): UsageWindow | null => {
  const currentStart = new Date(current.startAt);
  const currentEnd = new Date(current.endAt);
  const durationMs = currentEnd.getTime() - currentStart.getTime();
  if (!Number.isFinite(currentStart.getTime()) || !Number.isFinite(currentEnd.getTime()) || durationMs <= 0) return null;

  const previousStart = new Date(currentStart.getTime() - durationMs);
  return {
    label: 'Secondary window',
    startAt: previousStart.toISOString(),
    endAt: currentStart.toISOString(),
    startHour: hourString(previousStart),
    endHour: hourString(currentStart),
  };
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

const windowState = (
  binding: Pick<Binding, 'telegramUserId'>,
  upstreamId: string,
  window: UsageWindow,
  usedPercent: number | null,
): Omit<SecondaryWindowState, 'updatedAt'> => ({
  telegramUserId: binding.telegramUserId,
  upstreamId,
  windowStartAt: window.startAt,
  resetAfterAt: window.endAt,
  usedPercent,
});
