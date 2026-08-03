import {
  BindingStore,
  DatabaseRowError,
  type NewQuotaWindowEvent,
  type PendingQuotaWindowCandidate,
  type QuotaWindowCursor,
  type QuotaWindowDelivery,
  type QuotaWindowEvent,
  type QuotaWindowFacts,
} from './db.js';
import { FlowayHttpError } from './floway-client.js';
import {
  formatQuotaWindowEventNotification,
  formatQuotaEstimateNotification,
} from './format.js';
import {
  classifyQuotaWindowTransition,
  matchesQuotaWindowCandidate,
  CODEX_PREMIUM_ACTIVE_LIMIT,
  resolveQuotaWindowObservation,
  type QuotaWindowObservation,
} from './quota-window.js';
import {
  canShareUpstreamQuota,
  hourString,
  summarizeUsageQuotaEstimate,
  summarizeUsageWindow,
  type UsageWindow,
} from './usage.js';
import type {
  AuthMeResponse,
  Binding,
  FlowayAdminUser,
  SanitizedExportSnapshot,
  UpstreamRecord,
} from './types.js';

interface QuotaWindowFlowayClient {
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

interface QuotaWindowNotifierOptions {
  store: BindingStore;
  floway: QuotaWindowFlowayClient;
  bot: TelegramSender;
  intervalSeconds: number;
}

interface RefreshedBindings {
  current: RefreshedBinding[];
  retryableBindingIds: number[];
}

interface RefreshedBinding {
  binding: Binding;
  user: AuthMeResponse['user'];
}

const DELIVERY_LEASE_MS = 5 * 60_000;
const DELIVERY_RETRY_BASE_MS = 30_000;
const DELIVERY_RETRY_CAP_MS = 60 * 60_000;
const DELIVERY_MAX_ATTEMPTS = 8;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_DELIVERIES_PER_POLL = 100;
const CLOCK_SKEW_MS = 5 * 60_000;

export class QuotaWindowNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(private readonly options: QuotaWindowNotifierOptions) {}

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
    } finally {
      this.activePoll = null;
    }
  }

  private async poll(): Promise<void> {
    const nowMs = Date.now();
    try {
      await this.observeProviderWindows(nowMs);
    } catch (error) {
      console.error('Quota window observation failed:', error);
    }
    try {
      await this.dispatchDeliveries(nowMs);
    } catch (error) {
      console.error('Quota window delivery dispatch failed:', error);
    }
    try {
      this.options.store.purgeTerminalEvents(Math.max(0, nowMs - TERMINAL_RETENTION_MS));
    } catch (error) {
      console.error('Quota window delivery retention failed:', error);
    }
  }

  private async observeProviderWindows(nowMs: number): Promise<void> {
    const upstreams = await this.options.floway.listUpstreams();
    const refreshedBindings = await this.refreshBindings();

    for (const upstream of upstreams) {
      const resolution = resolveQuotaWindowObservation(upstream);
      if (resolution.status !== 'valid') {
        this.clearUnconfirmedCandidate(upstream.id);
        if (resolution.status === 'malformed' || resolution.status === 'ambiguous') {
          console.warn(`Ignored ${resolution.status} quota observation for upstream ${upstream.id}`);
        }
        continue;
      }

      const eligibleBindingIds = upstream.enabled
        ? [
          ...refreshedBindings.current
            .filter(bound => canUseUpstream(bound.user, upstream.id))
            .map(bound => bound.binding.bindingId),
          ...refreshedBindings.retryableBindingIds,
        ]
        : [];
      try {
        this.applyObservation(upstream, resolution.observation, eligibleBindingIds, nowMs);
      } catch (error) {
        if (error instanceof DatabaseRowError && error.table === 'quota_window_cursor') {
          console.error(`Reset corrupt quota window cursor for upstream ${upstream.id}:`, error);
          this.options.store.resetCursor(upstream.id);
          this.options.store.seedCursor(upstream.id, observationFacts(resolution.observation));
          continue;
        }
        console.error(`Failed to apply quota observation for upstream ${upstream.id}:`, error);
      }
    }
  }

  private async refreshBindings(): Promise<RefreshedBindings> {
    const listed = this.options.store.listBindingsSafely();
    for (const error of listed.errors) console.error(`Skipped invalid binding row ${error.bindingId ?? 'unknown'}: ${error.message}`);
    if (listed.probableWrongSecret) {
      console.error('All stored bindings failed authentication; BOT_SECRET_KEY may not match this database');
    }

    const current: RefreshedBinding[] = [];
    const retryableBindingIds: number[] = [];
    for (const binding of listed.bindings) {
      try {
        const me = await this.options.floway.getMe(binding.flowaySession);
        const stored = this.options.store.getByBindingId(binding.bindingId);
        if (!stored) continue;
        if (me.user.id !== binding.flowayUserId) {
          this.options.store.deleteBinding({ bindingId: binding.bindingId, telegramUserId: binding.telegramUserId });
          continue;
        }
        if (me.user.username !== binding.username) {
          const result = this.options.store.refreshBinding(binding.bindingId, {
            flowayUserId: binding.flowayUserId,
            username: me.user.username,
          });
          if (result.status !== 'updated') continue;
          current.push({ binding: result.binding, user: me.user });
        } else {
          current.push({ binding, user: me.user });
        }
      } catch (error) {
        if (error instanceof FlowayHttpError && error.status === 401) {
          this.options.store.deleteBinding({ bindingId: binding.bindingId, telegramUserId: binding.telegramUserId });
          continue;
        }
        retryableBindingIds.push(binding.bindingId);
        console.error(`Failed to refresh Floway binding ${binding.bindingId}:`, error);
      }
    }
    return { current, retryableBindingIds };
  }

  private applyObservation(
    upstream: UpstreamRecord,
    observation: QuotaWindowObservation,
    eligibleBindingIds: readonly number[],
    nowMs: number,
  ): void {
    if (observation.observedAtMs > nowMs + CLOCK_SKEW_MS) {
      console.warn(`Ignored future quota observation for upstream ${upstream.id}`);
      this.clearUnconfirmedCandidate(upstream.id);
      return;
    }

    const cursor = this.options.store.getCursor(upstream.id);
    if (!cursor) {
      this.options.store.seedCursor(upstream.id, observationFacts(observation));
      return;
    }

    const anchor = cursorObservation(cursor, observation.bucketKey);
    const classification = classifyQuotaWindowTransition(anchor, observation);
    if (classification === 'same') {
      this.options.store.updateSameObservation(upstream.id, cursor.revision, observationFacts(observation));
      return;
    }
    if (classification !== 'natural' && classification !== 'manual') {
      if (cursor.pending) this.options.store.clearPendingCandidate(upstream.id, cursor.revision);
      return;
    }

    if (!cursor.pending) {
      this.options.store.stagePendingCandidate(upstream.id, cursor.revision, pendingCandidate(classification, observation, nowMs));
      return;
    }

    const pendingObservationValue = pendingObservation(cursor, observation);
    if (cursor.pending.kind !== classification
      || !matchesQuotaWindowCandidate(pendingObservationValue, observation)) {
      this.options.store.replacePendingCandidate(upstream.id, cursor.revision, {
        ...pendingCandidate(classification, observation, nowMs),
        observationCount: 1,
      });
      return;
    }
    if (observation.startMs > nowMs) return;

    const confirmedPending: PendingQuotaWindowCandidate = {
      kind: cursor.pending.kind,
      startAtMs: observation.startMs,
      endAtMs: observation.endMs,
      durationMs: observation.durationMs,
      observedAtMs: observation.observedAtMs,
      firstSeenAtMs: cursor.pending.firstSeenAtMs,
      observationCount: cursor.pending.observationCount + 1,
    };
    const replaced = this.options.store.replacePendingCandidate(upstream.id, cursor.revision, confirmedPending);
    if (replaced.status !== 'updated') return;

    const event: NewQuotaWindowEvent = {
      upstreamId: upstream.id,
      fromRevision: cursor.revision,
      toRevision: cursor.revision + 1,
      upstreamKind: upstream.kind,
      upstreamName: upstream.name || upstream.id,
      kind: cursor.pending.kind,
      previous: cursor.latest,
      current: {
        startAtMs: confirmedPending.startAtMs,
        endAtMs: confirmedPending.endAtMs,
        durationMs: confirmedPending.durationMs,
        observedAtMs: confirmedPending.observedAtMs,
        usedPercent: observation.usedPercent,
        quotaBucketKey: observation.bucketKey,
        activeLimit: observation.activeLimit,
      },
      detectedAtMs: nowMs,
      effectivePreviousUsageEndAtMs: cursor.pending.kind === 'manual' ? cursor.pending.startAtMs : null,
    };
    this.options.store.commitTransition(cursor.revision, event, eligibleBindingIds, cursor.pending.firstSeenAtMs);
  }

  private clearUnconfirmedCandidate(upstreamId: string): void {
    try {
      const cursor = this.options.store.getCursor(upstreamId);
      if (cursor?.pending) this.options.store.clearPendingCandidate(upstreamId, cursor.revision);
    } catch (error) {
      console.error(`Failed to clear quota window candidate for upstream ${upstreamId}:`, error);
    }
  }

  private async dispatchDeliveries(nowMs: number): Promise<void> {
    for (let index = 0; index < MAX_DELIVERIES_PER_POLL; index += 1) {
      const delivery = this.options.store.claimDueDelivery({
        nowMs,
        leaseDurationMs: DELIVERY_LEASE_MS,
      });
      if (!delivery) return;
      await this.dispatchDelivery(delivery, nowMs);
    }
  }

  private async dispatchDelivery(delivery: QuotaWindowDelivery, nowMs: number): Promise<void> {
    const claimToken = delivery.claimToken;
    if (!claimToken) return;
    try {
      const event = this.options.store.getEvent(delivery.eventId);
      const binding = this.options.store.getByBindingId(delivery.bindingId);
      if (!event || !binding) {
        this.options.store.markDeliverySkipped(delivery.deliveryId, claimToken, 'Binding or event no longer exists', nowMs);
        return;
      }

      const me = await this.options.floway.getMe(binding.flowaySession);
      if (me.user.id !== binding.flowayUserId) {
        this.options.store.deleteBinding({ bindingId: binding.bindingId, telegramUserId: binding.telegramUserId });
        return;
      }
      if (!canUseUpstream(me.user, event.upstreamId)) {
        this.options.store.markDeliverySkipped(delivery.deliveryId, claimToken, 'Upstream is no longer available to this binding', nowMs);
        return;
      }
      const upstream = eventUpstream(event);

      let payload = delivery.payload;
      if (!payload) {
        payload = await this.renderDelivery(event, binding, upstream);
        if (!this.options.store.persistDeliveryPayload(delivery.deliveryId, claimToken, payload, nowMs)) return;
      }
      await this.options.bot.telegram.sendMessage(binding.telegramUserId, payload, { parse_mode: 'HTML' });
      this.options.store.markDeliverySent(delivery.deliveryId, claimToken, Date.now());
    } catch (error) {
      const binding = safeBinding(this.options.store, delivery.bindingId);
      if (error instanceof FlowayHttpError && error.status === 401 && binding) {
        this.options.store.deleteBinding({ bindingId: binding.bindingId, telegramUserId: binding.telegramUserId });
        return;
      }
      const message = safeErrorMessage(error);
      if (isPermanentTelegramError(error) || delivery.attempts >= DELIVERY_MAX_ATTEMPTS) {
        this.options.store.markDeliveryDead(delivery.deliveryId, claimToken, message, Date.now());
        return;
      }
      const retryDelay = Math.min(
        DELIVERY_RETRY_CAP_MS,
        DELIVERY_RETRY_BASE_MS * (2 ** Math.max(0, delivery.attempts - 1)),
      );
      const retryAt = Math.min(Date.now() + retryDelay, Number.MAX_SAFE_INTEGER);
      this.options.store.markDeliveryRetry(delivery.deliveryId, claimToken, retryAt, message, Date.now());
    }
  }

  private async renderDelivery(
    event: QuotaWindowEvent,
    binding: Binding,
    upstream: UpstreamRecord,
  ): Promise<string> {
    const previousWindow = eventPreviousUsageWindow(event);
    try {
      const [snapshot, users] = await Promise.all([
        this.options.floway.exportUsageSnapshot(),
        this.options.floway.listUsers(),
      ]);
      const report = summarizeUsageWindow(binding.flowayUserId, upstream.id, previousWindow, snapshot);
      const quotaEstimate = event.previous.usedPercent === null
        ? formatQuotaEstimateNotification(null)
        : formatQuotaEstimateNotification(summarizeUsageQuotaEstimate(
          binding.flowayUserId,
          upstream.id,
          previousWindow,
          event.previous.usedPercent,
          snapshot,
          users.filter(user => canShareUpstreamQuota(user, upstream.id)).length,
        ));
      return formatQuotaWindowEventNotification(upstream, event, report, quotaEstimate);
    } catch (error) {
      console.error(`Quota window delivery enrichment failed for event ${event.eventId}:`, error);
      return formatQuotaWindowEventNotification(
        upstream,
        event,
        null,
        'Approximate hourly usage and quota attribution are unavailable.',
      );
    }
  }
}

const eventUpstream = (event: QuotaWindowEvent): UpstreamRecord => ({
  id: event.upstreamId,
  kind: event.upstreamKind,
  name: event.upstreamName,
  enabled: true,
  sort_order: 0,
  created_at: new Date(event.detectedAtMs).toISOString(),
  updated_at: new Date(event.detectedAtMs).toISOString(),
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  color: null,
  config: null,
  state: null,
});

const observationFacts = (observation: QuotaWindowObservation): QuotaWindowFacts => ({
  startAtMs: observation.startMs,
  endAtMs: observation.endMs,
  durationMs: observation.durationMs,
  observedAtMs: observation.observedAtMs,
  usedPercent: observation.usedPercent,
  quotaBucketKey: observation.bucketKey,
  activeLimit: observation.activeLimit,
});

const cursorObservation = (cursor: QuotaWindowCursor, fallbackBucketKey: string): QuotaWindowObservation => ({
  upstreamId: cursor.upstreamId,
  bucketKey: cursor.latest.quotaBucketKey ?? fallbackBucketKey,
  activeLimit: CODEX_PREMIUM_ACTIVE_LIMIT,
  observedAt: new Date(cursor.latest.observedAtMs).toISOString(),
  observedAtMs: cursor.latest.observedAtMs,
  startAt: new Date(cursor.anchor.startAtMs).toISOString(),
  startMs: cursor.anchor.startAtMs,
  endAt: new Date(cursor.anchor.endAtMs).toISOString(),
  endMs: cursor.anchor.endAtMs,
  durationMs: cursor.anchor.durationMs,
  usedPercent: cursor.latest.usedPercent,
});

const pendingCandidate = (
  kind: 'natural' | 'manual',
  observation: QuotaWindowObservation,
  firstSeenAtMs: number,
): Omit<PendingQuotaWindowCandidate, 'observationCount'> => ({
  kind,
  startAtMs: observation.startMs,
  endAtMs: observation.endMs,
  durationMs: observation.durationMs,
  observedAtMs: observation.observedAtMs,
  firstSeenAtMs,
});

const pendingObservation = (
  cursor: QuotaWindowCursor,
  current: QuotaWindowObservation,
): QuotaWindowObservation => {
  const pending = cursor.pending!;
  return {
    upstreamId: cursor.upstreamId,
    bucketKey: current.bucketKey,
    activeLimit: CODEX_PREMIUM_ACTIVE_LIMIT,
    observedAt: new Date(pending.observedAtMs).toISOString(),
    observedAtMs: pending.observedAtMs,
    startAt: new Date(pending.startAtMs).toISOString(),
    startMs: pending.startAtMs,
    endAt: new Date(pending.endAtMs).toISOString(),
    endMs: pending.endAtMs,
    durationMs: pending.durationMs,
    usedPercent: current.usedPercent,
  };
};

const eventPreviousUsageWindow = (event: QuotaWindowEvent): UsageWindow => {
  const endAtMs = event.effectivePreviousUsageEndAtMs ?? event.previous.endAtMs;
  const start = new Date(event.previous.startAtMs);
  const end = new Date(endAtMs);
  return {
    label: 'Quota window',
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    startHour: hourString(start),
    endHour: hourString(end),
    startMs: start.getTime(),
    endMs: end.getTime(),
    durationMs: end.getTime() - start.getTime(),
    observedAt: new Date(event.previous.observedAtMs).toISOString(),
    observedAtMs: event.previous.observedAtMs,
    ...(event.previous.usedPercent !== null ? { upstreamPercent: event.previous.usedPercent } : {}),
    ...(event.previous.quotaBucketKey ? { quotaBucketKey: event.previous.quotaBucketKey } : {}),
    ...(event.previous.activeLimit ? { quotaActiveLimit: event.previous.activeLimit } : {}),
  };
};

const canUseUpstream = (user: Pick<AuthMeResponse['user'], 'upstreamIds'>, upstreamId: string): boolean =>
  user.upstreamIds === null || user.upstreamIds.includes(upstreamId);

const safeBinding = (store: BindingStore, bindingId: number): Binding | null => {
  try {
    return store.getByBindingId(bindingId);
  } catch {
    return null;
  }
};

const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
};

const isPermanentTelegramError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const response = 'response' in error && typeof error.response === 'object' && error.response !== null
    ? error.response as Record<string, unknown>
    : error as Record<string, unknown>;
  return response.error_code === 400 || response.error_code === 403;
};
