import { scopeUsageSnapshotForUser, summarizeUsageLeaderboard } from '../../src/usage.js';
import type { GlobalUsageSnapshot, UsageRecord } from '../../src/types.js';

const globalSnapshot: GlobalUsageSnapshot = {
  exportedAt: '2026-06-22T12:34:00.000Z',
  users: [],
  apiKeys: [],
  usage: [],
};

const scopedSnapshot = scopeUsageSnapshotForUser(globalSnapshot, { upstreamIds: [] });
summarizeUsageLeaderboard(scopedSnapshot);

// @ts-expect-error A global admin snapshot must be scoped before leaderboard aggregation.
summarizeUsageLeaderboard(globalSnapshot);

const structurallySimilar = {
  exportedAt: globalSnapshot.exportedAt,
  users: [] as ReadonlyArray<{ readonly id: number; readonly username: string }>,
  apiKeys: [] as ReadonlyArray<{ readonly id: string; readonly userId: number }>,
  usage: [] as ReadonlyArray<UsageRecord>,
};

// @ts-expect-error Only the scope function can construct a branded user snapshot.
summarizeUsageLeaderboard(structurallySimilar);

// @ts-expect-error The old upstreamIds argument is no longer accepted.
summarizeUsageLeaderboard(scopedSnapshot, 7, 4, new Date(), ['up_a']);
