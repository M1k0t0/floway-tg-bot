import { BindingStore, type SecondaryWindowNotification, type SecondaryWindowState } from './db.js';
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
  note?: string;
}

interface WindowRefresh {
  previousWindow: UsageWindow;
  currentWindow: UsageWindow;
}

export class SecondaryWindowNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(private readonly options: SecondaryWindowNotifierOptions) {}

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.options.intervalSeconds * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const activePoll = this.activePoll;
    if (activePoll) await activePoll;
  }

  async pollOnce(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    const poll = this.runPoll();
    this.activePoll = poll;
    await poll;
  }

  private async runPoll(): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      console.error('Secondary window notifier failed:', error);
    } finally {
      this.activePoll = null;
    }
  }

  private async poll(): Promise<void> {
    const now = new Date();
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
        if (currentWindow && isWindowFromFuture(currentWindow, now)) {
          const elapsed = previous ? elapsedWindowRefreshFromState(previous, now) : null;
          if (elapsed) {
            this.enqueueOrApplySentNotification(candidates, {
              binding: bound.binding,
              upstream,
              previousWindow: elapsed.previousWindow,
              currentWindow: elapsed.currentWindow,
              currentState: windowState(bound.binding, upstream.id, elapsed.currentWindow, null),
            });
          } else if (previous) {
            const storedWindow = windowFromState(previous);
            const previousWindow = shouldBackfillCompletedWindow(bound.binding, storedWindow, now)
              ? completedWindowBefore(storedWindow)
              : null;
            if (previousWindow) {
              this.enqueueOrApplySentNotification(candidates, {
                binding: bound.binding,
                upstream,
                previousWindow,
                currentWindow: storedWindow,
                currentState: windowState(bound.binding, upstream.id, storedWindow, previous.usedPercent),
              });
            }
          }
          continue;
        }
        if (!currentWindow) {
          if (!canUseMissingCodexQuotaState(upstream)) {
            this.options.store.deleteSecondaryWindowState(bound.binding.telegramUserId, upstream.id);
            continue;
          }
          const elapsed = previous ? elapsedWindowRefreshFromState(previous, now) : null;
          if (elapsed) {
            this.enqueueOrApplySentNotification(candidates, {
              binding: bound.binding,
              upstream,
              previousWindow: elapsed.previousWindow,
              currentWindow: elapsed.currentWindow,
              currentState: windowState(bound.binding, upstream.id, elapsed.currentWindow, null),
            });
          } else if (previous) {
            const storedWindow = windowFromState(previous);
            const previousWindow = shouldBackfillCompletedWindow(bound.binding, storedWindow, now)
              ? completedWindowBefore(storedWindow)
              : null;
            if (previousWindow) {
              this.enqueueOrApplySentNotification(candidates, {
                binding: bound.binding,
                upstream,
                previousWindow,
                currentWindow: storedWindow,
                currentState: windowState(bound.binding, upstream.id, storedWindow, previous.usedPercent),
              });
            }
          }
          continue;
        }

        const currentState = windowState(bound.binding, upstream.id, currentWindow, currentWindow.upstreamPercent ?? null);

        if (previous && isManualWindowRefresh(previous, currentWindow)) {
          this.enqueueOrApplySentNotification(candidates, {
            binding: bound.binding,
            upstream,
            previousWindow: manualRefreshWindowToReport(previous, currentWindow),
            currentWindow,
            currentState,
            note: 'Upstream refreshed this secondary window early; this is not a natural cycle.',
          });
          continue;
        }

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
          const elapsed = elapsedWindowRefreshFromState(previous, now);
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
            const previousWindow = shouldBackfillCompletedWindow(bound.binding, storedWindow, now)
              ? completedWindowBefore(storedWindow)
              : null;
            if (previousWindow) {
              const storedWindowMatchesCurrent = isSameWindowPeriod(storedWindow, currentWindow);
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
          const elapsed = elapsedWindowRefresh(currentWindow, now);
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
          } else if (shouldCatchUpMissingState(bound.binding, currentWindow, now)) {
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
    const text = formatSecondaryWindowNotification(candidate.upstream, report, quotaEstimate, candidate.note);
    for (const chunk of splitMessage(text)) {
      await this.options.bot.telegram.sendMessage(candidate.binding.telegramUserId, chunk, { parse_mode: 'HTML' });
    }
  }

  private enqueueOrApplySentNotification(candidates: NotificationCandidate[], candidate: NotificationCandidate): void {
    const sent = this.options.store.getSecondaryWindowNotificationEndingByHour(
      candidate.binding.telegramUserId,
      candidate.upstream.id,
      candidate.previousWindow.endHour,
    );
    if (!sent || !wasNotificationSentAfterWindowEnded(sent, candidate.previousWindow)) {
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
  const stored = windowFromState(previous);
  if (isSameWindowPeriod(stored, current)) return false;
  return isHourAfter(current.endHour, stored.endHour);
};

const isWindowAtLeast = (previous: SecondaryWindowState, current: UsageWindow): boolean => {
  const stored = windowFromState(previous);
  return isHourAtOrAfter(current.endHour, stored.endHour);
};

const isManualWindowRefresh = (previous: SecondaryWindowState, current: UsageWindow): boolean => {
  const stored = windowFromState(previous);
  if (isSameWindowPeriod(stored, current)) return false;
  return isHourAfter(current.startHour, stored.startHour)
    && isHourBefore(current.startHour, stored.endHour)
    && isHourAfter(current.endHour, stored.endHour);
};

const isSameWindowPeriod = (left: UsageWindow, right: UsageWindow): boolean =>
  left.startHour === right.startHour && left.endHour === right.endHour;

const isWindowFromFuture = (window: UsageWindow, now: Date): boolean => {
  const nowHour = hourStringOrNull(now);
  return nowHour !== null && isHourAfter(window.startHour, nowHour);
};

const wasNotificationSentAfterWindowEnded = (
  notification: Pick<SecondaryWindowNotification, 'sentAt'>,
  window: UsageWindow,
): boolean => {
  const sentHour = hourStringOrNull(new Date(notification.sentAt));
  return sentHour !== null && isHourAtOrAfter(sentHour, window.endHour);
};

const windowToReport = (previous: SecondaryWindowState, current: UsageWindow): UsageWindow => {
  const previousWindow = windowFromState(previous);
  const completed = completedWindowBefore(current);
  if (!completed) return previousWindow;
  if (isSameWindowPeriod(previousWindow, completed)) return previousWindow;

  if (isHourAfter(completed.endHour, previousWindow.endHour)) {
    return completed;
  }
  return previousWindow;
};

const manualRefreshWindowToReport = (previous: SecondaryWindowState, current: UsageWindow): UsageWindow => {
  const window = windowFromState(previous);
  return {
    ...window,
    endAt: current.startAt,
    endHour: current.startHour,
  };
};

const elapsedWindowRefreshFromState = (previous: SecondaryWindowState, now = new Date()): WindowRefresh | null =>
  elapsedWindowRefresh(windowFromState(previous), now);

const elapsedWindowRefresh = (knownWindow: UsageWindow, now: Date): WindowRefresh | null => {
  const start = new Date(knownWindow.startAt);
  const end = new Date(knownWindow.endAt);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const nowMs = now.getTime();
  const nowHour = hourStringOrNull(now);
  const durationMs = endMs - startMs;
  if (
    !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || !Number.isFinite(nowMs)
    || nowHour === null
    || durationMs <= 0
    || isHourBefore(nowHour, knownWindow.endHour)
  ) {
    return null;
  }

  const elapsedCompletedWindows = Math.max(0, Math.floor((nowMs - endMs) / durationMs));
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
  const nowHour = hourStringOrNull(now);
  if (nowHour === null || isHourAfter(currentWindow.startHour, nowHour)) return false;
  const previousWindow = completedWindowBefore(currentWindow);
  return previousWindow !== null && wasBoundBeforeWindowEnded(binding, previousWindow);
};

const shouldCatchUpMissingState = (binding: Pick<Binding, 'createdAt'>, current: UsageWindow, now = new Date()): boolean => {
  const bindingCreatedHour = hourStringOrNull(new Date(binding.createdAt));
  const nowHour = hourStringOrNull(now);
  return bindingCreatedHour !== null
    && nowHour !== null
    && isHourBefore(bindingCreatedHour, current.startHour)
    && isHourAtOrBefore(current.startHour, nowHour);
};

const wasBoundBeforeWindowEnded = (binding: Pick<Binding, 'createdAt'>, window: UsageWindow): boolean => {
  const bindingCreatedHour = hourStringOrNull(new Date(binding.createdAt));
  return bindingCreatedHour !== null && isHourBefore(bindingCreatedHour, window.endHour);
};

const isHourBefore = (left: string, right: string): boolean => left < right;

const isHourAfter = (left: string, right: string): boolean => left > right;

const isHourAtOrBefore = (left: string, right: string): boolean => left <= right;

const isHourAtOrAfter = (left: string, right: string): boolean => left >= right;

const hourStringOrNull = (date: Date): string | null =>
  Number.isFinite(date.getTime()) ? hourString(date) : null;

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
