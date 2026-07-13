import { BindingStore, type PrimaryWindowNotification, type PrimaryWindowState } from './db.js';
import { FlowayHttpError } from './floway-client.js';
import {
  formatQuotaEstimateInsufficientNotification,
  formatQuotaEstimateNotification,
  formatPrimaryWindowNotification,
  splitMessage,
} from './format.js';
import {
  canShareUpstreamQuota,
  selectPrimaryQuotaWindowForUpstream,
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

interface PrimaryWindowFlowayClient {
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

interface PrimaryWindowNotifierOptions {
  store: BindingStore;
  floway: PrimaryWindowFlowayClient;
  bot: TelegramSender;
  intervalSeconds: number;
}

interface NotificationCandidate {
  binding: Binding;
  upstream: UpstreamRecord;
  previousWindow: UsageWindow;
  currentWindow: UsageWindow;
  currentState: Omit<PrimaryWindowState, 'updatedAt'>;
  note?: string;
}

interface WindowRefresh {
  previousWindow: UsageWindow;
  currentWindow: UsageWindow;
}

const WINDOW_BOUNDARY_DEBOUNCE_MS = 5 * 60 * 60 * 1000;

export class PrimaryWindowNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(private readonly options: PrimaryWindowNotifierOptions) {}

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
      console.error('Primary window notifier failed:', error);
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
      this.options.store.deletePrimaryWindowStatesExcept(
        bound.binding.telegramUserId,
        allowedUpstreams.map(upstream => upstream.id),
      );

      for (const upstream of allowedUpstreams) {
        const previous = this.options.store.getPrimaryWindowState(bound.binding.telegramUserId, upstream.id);
        const currentWindow = primaryWindowForUpstream(upstream);
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
            this.options.store.deletePrimaryWindowState(bound.binding.telegramUserId, upstream.id);
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

        if (previous && didQuotaBucketChange(previous, currentWindow)) {
          this.options.store.upsertPrimaryWindowState(currentState);
          continue;
        }

        if (previous && isManualWindowRefresh(previous, currentWindow)) {
          this.enqueueOrApplySentNotification(candidates, {
            binding: bound.binding,
            upstream,
            previousWindow: manualRefreshWindowToReport(previous, currentWindow),
            currentWindow,
            currentState,
            note: 'Upstream refreshed this primary window early; this is not a natural cycle.',
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
              this.options.store.upsertPrimaryWindowState(currentState);
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
              this.options.store.upsertPrimaryWindowState(elapsedState);
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
              this.options.store.upsertPrimaryWindowState(currentState);
            }
          } else {
            this.options.store.upsertPrimaryWindowState(currentState);
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
        this.options.store.upsertPrimaryWindowNotification({
          telegramUserId: candidate.binding.telegramUserId,
          upstreamId: candidate.upstream.id,
          windowStartAt: candidate.previousWindow.startAt,
          resetAfterAt: candidate.previousWindow.endAt,
        });
        this.options.store.upsertPrimaryWindowState(candidate.currentState);
      } catch (error) {
        console.error(`Failed to send primary window notification to Telegram user ${candidate.binding.telegramUserId}:`, error);
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
    const text = formatPrimaryWindowNotification(candidate.upstream, report, quotaEstimate, candidate.note);
    for (const chunk of splitMessage(text)) {
      await this.options.bot.telegram.sendMessage(candidate.binding.telegramUserId, chunk, { parse_mode: 'HTML' });
    }
  }

  private enqueueOrApplySentNotification(candidates: NotificationCandidate[], candidate: NotificationCandidate): void {
    const sent = this.options.store.getPrimaryWindowNotificationEndingByHour(
      candidate.binding.telegramUserId,
      candidate.upstream.id,
      candidate.previousWindow.endHour,
    );
    if (!sent || !wasNotificationSentAfterWindowEnded(sent, candidate.previousWindow)) {
      candidates.push(candidate);
      return;
    }
    this.options.store.upsertPrimaryWindowState(candidate.currentState);
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

const primaryWindowForUpstream = (upstream: UpstreamRecord): UsageWindow | null =>
  selectPrimaryQuotaWindowForUpstream(upstream);

const canUseMissingCodexQuotaState = (upstream: UpstreamRecord): boolean =>
  upstream.kind === 'codex' && !upstream.codex_quota;

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

const didQuotaBucketChange = (previous: PrimaryWindowState, current: UsageWindow): boolean =>
  previous.quotaBucketKey !== null
  && previous.quotaBucketKey !== (current.quotaBucketKey ?? null);

const didWindowRefresh = (previous: PrimaryWindowState, current: UsageWindow): boolean => {
  const stored = windowFromState(previous);
  if (isSameWindowPeriod(stored, current)) return false;
  return isBoundaryAfterOutsideDebounce(current.endAt, stored.endAt);
};

const isWindowAtLeast = (previous: PrimaryWindowState, current: UsageWindow): boolean => {
  const stored = windowFromState(previous);
  return isSameWindowPeriod(stored, current) || isBoundaryAtOrAfter(current.endAt, stored.endAt);
};

const isManualWindowRefresh = (previous: PrimaryWindowState, current: UsageWindow): boolean => {
  const stored = windowFromState(previous);
  if (isSameWindowPeriod(stored, current)) return false;
  return isBoundaryAfterOutsideDebounce(current.startAt, stored.startAt)
    && isBoundaryBeforeOutsideDebounce(current.startAt, stored.endAt)
    && isBoundaryAfterOutsideDebounce(current.endAt, stored.endAt);
};

const isSameWindowPeriod = (left: UsageWindow, right: UsageWindow): boolean =>
  isWithinWindowBoundaryDebounce(left.startAt, right.startAt)
  && isWithinWindowBoundaryDebounce(left.endAt, right.endAt);

const isWithinWindowBoundaryDebounce = (left: string, right: string): boolean => {
  const leftMs = boundaryTime(left);
  const rightMs = boundaryTime(right);
  return leftMs !== null
    && rightMs !== null
    && Math.abs(leftMs - rightMs) <= WINDOW_BOUNDARY_DEBOUNCE_MS;
};

const isBoundaryBeforeOutsideDebounce = (left: string, right: string): boolean => {
  const leftMs = boundaryTime(left);
  const rightMs = boundaryTime(right);
  return leftMs !== null && rightMs !== null && leftMs < rightMs - WINDOW_BOUNDARY_DEBOUNCE_MS;
};

const isBoundaryAfterOutsideDebounce = (left: string, right: string): boolean => {
  const leftMs = boundaryTime(left);
  const rightMs = boundaryTime(right);
  return leftMs !== null && rightMs !== null && leftMs > rightMs + WINDOW_BOUNDARY_DEBOUNCE_MS;
};

const isBoundaryAtOrAfter = (left: string, right: string): boolean => {
  const leftMs = boundaryTime(left);
  const rightMs = boundaryTime(right);
  return leftMs !== null && rightMs !== null && leftMs >= rightMs;
};

const boundaryTime = (value: string): number | null => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

const isWindowFromFuture = (window: UsageWindow, now: Date): boolean => {
  const nowHour = hourStringOrNull(now);
  return nowHour !== null && isHourAfter(window.startHour, nowHour);
};

const wasNotificationSentAfterWindowEnded = (
  notification: Pick<PrimaryWindowNotification, 'sentAt'>,
  window: UsageWindow,
): boolean => {
  const sentHour = hourStringOrNull(new Date(notification.sentAt));
  return sentHour !== null && isHourAtOrAfter(sentHour, window.endHour);
};

const windowToReport = (previous: PrimaryWindowState, current: UsageWindow): UsageWindow => {
  const previousWindow = windowFromState(previous);
  const completed = completedWindowBefore(current);
  if (!completed) return previousWindow;
  if (isSameWindowPeriod(previousWindow, completed)) return previousWindow;

  if (isHourAfter(completed.endHour, previousWindow.endHour)) {
    return completed;
  }
  return previousWindow;
};

const manualRefreshWindowToReport = (previous: PrimaryWindowState, current: UsageWindow): UsageWindow => {
  const window = windowFromState(previous);
  return {
    ...window,
    endAt: current.startAt,
    endHour: current.startHour,
  };
};

const elapsedWindowRefreshFromState = (previous: PrimaryWindowState, now = new Date()): WindowRefresh | null =>
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
      ...(knownWindow.quotaBucketKey ? { quotaBucketKey: knownWindow.quotaBucketKey } : {}),
      ...(knownWindow.quotaActiveLimit ? { quotaActiveLimit: knownWindow.quotaActiveLimit } : {}),
    },
    currentWindow: {
      label: knownWindow.label,
      startAt: previousEnd.toISOString(),
      endAt: currentEnd.toISOString(),
      startHour: hourString(previousEnd),
      endHour: hourString(currentEnd),
      ...(knownWindow.quotaBucketKey ? { quotaBucketKey: knownWindow.quotaBucketKey } : {}),
      ...(knownWindow.quotaActiveLimit ? { quotaActiveLimit: knownWindow.quotaActiveLimit } : {}),
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
    label: 'Primary window',
    startAt: previousStart.toISOString(),
    endAt: currentStart.toISOString(),
    startHour: hourString(previousStart),
    endHour: hourString(currentStart),
  };
};

const windowFromState = (state: PrimaryWindowState): UsageWindow => {
  const window: UsageWindow = {
    label: 'Primary window',
    startAt: state.windowStartAt,
    endAt: state.resetAfterAt,
    startHour: hourString(new Date(state.windowStartAt)),
    endHour: hourString(new Date(state.resetAfterAt)),
  };
  if (state.usedPercent !== null) window.upstreamPercent = state.usedPercent;
  if (state.quotaBucketKey !== null) window.quotaBucketKey = state.quotaBucketKey;
  return window;
};

const windowState = (
  binding: Pick<Binding, 'telegramUserId'>,
  upstreamId: string,
  window: UsageWindow,
  usedPercent: number | null,
): Omit<PrimaryWindowState, 'updatedAt'> => ({
  telegramUserId: binding.telegramUserId,
  upstreamId,
  windowStartAt: window.startAt,
  resetAfterAt: window.endAt,
  usedPercent,
  quotaBucketKey: window.quotaBucketKey ?? null,
});
