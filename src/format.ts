import type {
  ApiKeyRecord,
  Binding,
  CopilotQuotaResponse,
  TokenUsage,
  UpstreamModelRecord,
  UpstreamRecord,
} from './types.js';
import {
  BILLING_DIMENSIONS,
  tokenTotal,
  type UsageLeaderboardEntry,
  type UsageLeaderboardReport,
  type UsageQuotaEstimate,
  type UsageWindowReport,
} from './usage.js';

const MAX_TELEGRAM_MESSAGE = 3900;

export const html = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const bold = (value: unknown): string => `<b>${html(value)}</b>`;
const code = (value: unknown): string => `<code>${html(value)}</code>`;
const label = (name: string, value: unknown): string => `${bold(name)}: ${value}`;
const blockTitle = (name: string): string => bold(name);

export const splitMessage = (text: string, maxLength = MAX_TELEGRAM_MESSAGE): string[] => {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const cut = Math.max(rest.lastIndexOf('\n', maxLength), rest.lastIndexOf(' ', maxLength));
    const index = cut > maxLength * 0.5 ? cut : maxLength;
    chunks.push(rest.slice(0, index).trimEnd());
    rest = rest.slice(index).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
};

export const formatMoney = (value: number): string => {
  if (!Number.isFinite(value)) return '$0.00';
  if (Math.abs(value) < 0.0001 && value !== 0) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(value >= 1 ? 4 : 6)}`;
};

export const formatNumber = (value: number): string => new Intl.NumberFormat('en-US').format(value);

export const formatPercent = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : `${value.toFixed(value >= 10 ? 1 : 2)}%`;

export const formatProgressPercent = (value: number | null | undefined): string => {
  const width = 15;
  if (value === null || value === undefined || !Number.isFinite(value)) return `[${' '.repeat(width)}] ${bold('n/a')}`;
  const filled = value <= 0 ? 0 : Math.max(1, Math.min(width, Math.ceil((value / 100) * width)));
  return `[${'|'.repeat(filled)}${' '.repeat(width - filled)}] ${bold(formatPercent(value))}`;
};

export const formatTimestamp = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return 'n/a';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toISOString();
};

export const formatTokenUsage = (tokens: TokenUsage): string => {
  const parts = BILLING_DIMENSIONS
    .filter(dimension => (tokens[dimension] ?? 0) > 0)
    .map(dimension => `${code(dimension)} ${formatNumber(tokens[dimension] ?? 0)}`);
  return parts.length ? parts.join(', ') : '0';
};

export const formatBinding = (binding: Binding): string =>
  [
    blockTitle('Floway binding'),
    label('User', html(binding.username)),
    label('ID', code(binding.flowayUserId)),
    label('Updated', code(binding.updatedAt)),
  ].join('\n');

export const formatBindDeepLinkSuccess = (username: string, password: string): string =>
  [
    blockTitle('Floway account bound'),
    label('Username', html(username)),
    label('Password', `<tg-spoiler>${html(password)}</tg-spoiler>`),
  ].join('\n');

export const formatStartHelp = (binding: Binding | null): string => {
  if (!binding) {
    return [
      blockTitle('Floway bot'),
      'Bind your Floway account in this private chat:',
      code('/bind <username> <password>'),
      '',
      'After binding, use this bot to manage API keys, inspect upstreams, and view usage.',
    ].join('\n');
  }

  return [
    blockTitle('Floway bot'),
    label('Signed in', html(binding.username)),
    '',
    blockTitle('Commands'),
    `${code('/info')} - API endpoints and client setup`,
    `${code('/keys')} - list your API keys`,
    `${code('/newkey <name> all')} - create an API key`,
    `${code('/upstreams')} - list upstreams`,
    `${code('/usage <upstream_id>')} - upstream usage`,
    `${code('/quota <upstream_id>')} - estimated secondary quota`,
    `${code('/leaderboard [1d|7d|30d]')} - top users by tokens, cost, and cache`,
    `${code('/me')} - binding info`,
  ].join('\n');
};

export const formatInfo = (baseUrl: string): string => {
  const normalized = baseUrl.replace(/\/+$/, '');
  return [
    blockTitle('Floway client info'),
    label('Base URL', code(normalized)),
    '',
    blockTitle('Endpoints'),
    label('OpenAI Responses', code(`${normalized}/v1/responses`)),
    label('OpenAI Chat Completions', code(`${normalized}/v1/chat/completions`)),
    label('OpenAI Models', code(`${normalized}/v1/models`)),
    label('Anthropic Messages', code(`${normalized}/v1/messages`)),
    label('Gemini', code(`${normalized}/v1beta/models/...`)),
    '',
    blockTitle('API key'),
    'Use /keys to view your keys.',
    'Use /newkey &lt;name&gt; all to create one.',
    'OpenAI-compatible clients usually send it as Authorization: Bearer &lt;key&gt;.',
    'Anthropic-compatible clients can use x-api-key: &lt;key&gt;.',
    '',
    blockTitle('Bind links'),
    'Generate one with: corepack pnpm bind-link &lt;username-or-user-id&gt; &lt;password&gt;',
    'Telegram start payloads are limited to 64 encoded characters.',
  ].join('\n');
};

export const formatUpstreamList = (upstreams: readonly UpstreamRecord[]): string => {
  if (upstreams.length === 0) return blockTitle('No upstreams found.');
  const rows = upstreams
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(upstream => {
      const status = upstream.enabled ? 'enabled' : 'disabled';
      const codexQuota = codexQuotaForDisplay(upstream);
      const quotaLine = codexQuota
        ? `\n   primary ${bold(formatPercent(codexQuota.primary_used_percent))}, secondary ${bold(formatPercent(codexQuota.secondary_used_percent))}`
        : '';
      return `${upstream.sort_order}. ${bold(upstream.name)} ${code(upstream.id)}\n   ${code(upstream.provider)} | ${status}${quotaLine}`;
    });
  return [blockTitle(`Floway upstreams (${upstreams.length})`), ...rows].join('\n\n');
};

export const formatUpstreamSelectionRequired = (command: 'upstream' | 'usage' | 'quota' | 'quota verbose' | 'test_secondary_window', upstreams: readonly UpstreamRecord[]): string => {
  if (upstreams.length === 0) return blockTitle('No upstreams found.');
  return [
    blockTitle('Choose an upstream'),
    `Use ${code(`/${command} <upstream_id>`)}`,
    '',
    ...upstreams
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(upstream => `- ${bold(upstream.name)} ${code(upstream.id)}`),
  ].join('\n');
};

export const formatUpstreamDetail = (
  upstream: UpstreamRecord,
  models: readonly UpstreamModelRecord[],
  copilotQuota: CopilotQuotaResponse | null,
): string => {
  const lines = [
    `${bold(upstream.name)} ${code(upstream.id)}`,
    label('Provider', code(upstream.provider)),
    label('Status', upstream.enabled ? 'enabled' : 'disabled'),
    label('Sort order', code(upstream.sort_order)),
    label('Updated', code(upstream.updated_at)),
    label('Models cache', formatModelsCache(upstream)),
  ];

  const codexQuota = codexQuotaForDisplay(upstream);
  if (codexQuota) {
    lines.push(
      '',
      blockTitle('Codex quota'),
      label('Observed', code(codexQuota.observed_at)),
      label('Primary', [
        bold(formatPercent(codexQuota.primary_used_percent)),
        codexQuota.primary_window_minutes ? `${formatNumber(codexQuota.primary_window_minutes)} min` : null,
        codexQuota.primary_reset_after_at ? `resets ${code(codexQuota.primary_reset_after_at)}` : null,
      ].filter(Boolean).join(' | ')),
      label('Secondary', [
        bold(formatPercent(codexQuota.secondary_used_percent)),
        codexQuota.secondary_window_minutes ? `${formatNumber(codexQuota.secondary_window_minutes)} min` : null,
        codexQuota.secondary_reset_after_at ? `resets ${code(codexQuota.secondary_reset_after_at)}` : null,
      ].filter(Boolean).join(' | ')),
    );
    if (codexQuota.active_limit) lines.push(label('Active limit', code(codexQuota.active_limit)));
    if (codexQuota.credits_balance !== undefined) lines.push(label('Credits', code(codexQuota.credits_balance)));
    if (codexQuota.ratelimited_until) lines.push(label('Rate-limited until', code(codexQuota.ratelimited_until)));
  }

  if (copilotQuota) {
    lines.push('', blockTitle('Copilot quota'), code(stringifyCompact(copilotQuota)));
  }

  lines.push('', blockTitle(`Models (${models.length})`));
  if (models.length === 0) {
    lines.push('No models returned.');
  } else {
    for (const model of models.slice(0, 30)) {
      const endpoints = Object.keys(model.endpoints ?? {}).join(', ') || 'none';
      const display = model.display_name && model.display_name !== model.publicModelId ? ` ${html(model.display_name)}` : '';
      const limits = model.limits ? ` | limits ${code(stringifyCompact(model.limits))}` : '';
      lines.push(`- ${code(model.publicModelId)}${display}: ${html(model.kind ?? 'unknown')} | ${html(endpoints)}${limits}`);
    }
    if (models.length > 30) lines.push(`... ${models.length - 30} more omitted`);
  }

  return lines.join('\n');
};

export const formatKeys = (keys: readonly ApiKeyRecord[]): string => {
  if (keys.length === 0) return blockTitle('No active keys.');
  return [
    blockTitle(`Your Floway API keys (${keys.length})`),
    ...keys.map(key => [
      `${bold(key.name)} ${code(key.id)}`,
      `  ${label('Created', code(key.created_at))}`,
      `  ${label('Last used', key.last_used_at ? code(key.last_used_at) : 'never')}`,
      `  ${label('Upstreams', key.upstream_ids ? key.upstream_ids.map(id => code(id)).join(', ') : 'all allowed by user')}`,
    ].join('\n')),
  ].join('\n\n');
};

export const formatCreatedKey = (key: ApiKeyRecord, verb: 'created' | 'rotated'): string =>
  [
    blockTitle(`Key ${verb}`),
    label('Name', html(key.name)),
    label('ID', code(key.id)),
    label('Secret', code(key.key)),
  ].join('\n');

export const formatUsageReports = (upstream: UpstreamRecord, reports: readonly UsageWindowReport[]): string => {
  if (reports.length === 0) {
    return [
      blockTitle('Usage unavailable'),
      `No primary/secondary windows are available for ${bold(upstream.name)} ${code(upstream.id)}.`,
    ].join('\n');
  }
  const lines = [`${blockTitle('Usage')} ${bold(upstream.name)} ${code(upstream.id)}`];
  for (const report of reports) {
    lines.push(
      '',
      blockTitle(report.window.label),
      label('Window', `${code(report.window.startAt)} -> ${code(report.window.endAt)}`),
      label('Floway upstream used', bold(formatPercent(report.window.upstreamPercent))),
      label('Your share by tokens', bold(formatPercent(report.userTokenSharePercent))),
      label('Your share by requests', bold(formatPercent(report.userRequestSharePercent))),
      label('Your upstream tokens', `${bold(formatNumber(tokenTotal(report.user.tokens)))} (${formatTokenUsage(report.user.tokens)})`),
      label('All upstream tokens', `${bold(formatNumber(tokenTotal(report.upstream.tokens)))} (${formatTokenUsage(report.upstream.tokens)})`),
      label('Requests', `${bold(formatNumber(report.user.requests))} / ${formatNumber(report.upstream.requests)}`),
      label('Your upstream cost', bold(formatMoney(report.user.cost))),
      label('All upstream cost', formatMoney(report.upstream.cost)),
    );
  }
  return lines.join('\n');
};

export const formatSecondaryWindowNotification = (
  upstream: UpstreamRecord,
  report: UsageWindowReport,
  quotaEstimate: string,
  note?: string,
): string => {
  const lines = [
    blockTitle('Secondary window refreshed'),
    `${bold(upstream.name)} ${code(upstream.id)}`,
    '',
    label('Previous window', `${code(report.window.startAt)} -> ${code(report.window.endAt)}`),
  ];
  if (note) lines.push(label('Window note', html(note)));
  lines.push(
    label('Your upstream tokens', `${bold(formatNumber(tokenTotal(report.user.tokens)))} (${formatTokenUsage(report.user.tokens)})`),
    label('All upstream tokens', `${bold(formatNumber(tokenTotal(report.upstream.tokens)))} (${formatTokenUsage(report.upstream.tokens)})`),
    label('Requests', `${bold(formatNumber(report.user.requests))} / ${formatNumber(report.upstream.requests)}`),
    label('Upstream cost', `${bold(formatMoney(report.user.cost))} / ${formatMoney(report.upstream.cost)}`),
    '',
    quotaEstimate,
  );
  return lines.join('\n');
};

export const formatQuotaEstimate = (upstream: UpstreamRecord, report: UsageQuotaEstimate | null): string => {
  if (!report) {
    return [
      blockTitle('Quota estimate unavailable'),
      `Secondary quota window is not available for ${bold(upstream.name)} ${code(upstream.id)}.`,
    ].join('\n');
  }

  return [
    blockTitle('Quota estimate'),
    '',
    bold(upstream.name),
    `Reset in ${formatDurationUntil(report.window.endAt)}`,
    `${bold('Upstream secondary used')}:`,
    formatProgressPercent(report.upstreamUsedPercent),
    `${bold('Estimated your used')}:`,
    `${formatProgressPercent(report.estimatedUserUsedPercent)} of your equal share (${html(`Assumed ${formatNumber(report.nonAdminUserCount)} users`)})`,
    '',
    `${blockTitle('Estimate only')}: This uses current upstream-level usage and raw token totals. Actual per-user quota pressure depends on every upstream user's model mix and cache rate.`,
  ].join('\n');
};

export const formatQuotaEstimateNotification = (report: UsageQuotaEstimate | null): string => {
  if (!report) return 'Secondary quota estimate unavailable.';

  return [
    `${bold('Upstream secondary used')}:`,
    formatProgressPercent(report.upstreamUsedPercent),
    `${bold('Estimated your used')}:`,
    `${formatProgressPercent(report.estimatedUserUsedPercent)} of your equal share (${html(`Assumed ${formatNumber(report.nonAdminUserCount)} users`)})`,
  ].join('\n');
};

export const formatQuotaEstimateVerbose = (upstream: UpstreamRecord, report: UsageQuotaEstimate | null): string => {
  if (!report) {
    return [
      blockTitle('Quota estimate unavailable'),
      `Secondary quota window is not available for ${bold(upstream.name)} ${code(upstream.id)}.`,
    ].join('\n');
  }

  return [
    `${blockTitle('Quota estimate')} ${bold(upstream.name)} ${code(upstream.id)}`,
    label('Window', `${code(report.window.startAt)} -> ${code(report.window.endAt)}`),
    label('Upstream secondary used', formatProgressPercent(report.upstreamUsedPercent)),
    label('Assumed users', `${formatNumber(report.nonAdminUserCount)} non-admin Floway users`),
    label('Equal upstream share', formatProgressPercent(report.equalSharePercent)),
    '',
    label('Your upstream tokens', bold(formatNumber(tokenTotal(report.user.tokens)))),
    label('All upstream tokens', bold(formatNumber(tokenTotal(report.upstream.tokens)))),
    label('Your token share', formatProgressPercent(report.userTokenSharePercent)),
    label('Your estimated upstream quota share', formatProgressPercent(report.userUpstreamQuotaSharePercent)),
    label('Estimated your used', `${formatProgressPercent(report.estimatedUserUsedPercent)} of your equal share`),
    '',
    `${blockTitle('Estimate only')}: This uses current upstream-level usage and raw token totals. Actual per-user quota pressure depends on every upstream user's model mix and cache rate.`,
  ].join('\n');
};

export const formatQuotaEstimateInsufficient = (upstream: UpstreamRecord, windowStartAt: string, windowEndAt: string, upstreamUsedPercent: number): string =>
  [
    blockTitle('Quota estimate'),
    '',
    bold(upstream.name),
    `Reset in ${formatDurationUntil(windowEndAt)}`,
    `${bold('Upstream secondary used')}:`,
    formatProgressPercent(upstreamUsedPercent),
    '',
    'Not enough usage data yet. The limit probably just reset, so go make some requests.',
  ].join('\n');

export const formatQuotaEstimateInsufficientNotification = (upstreamUsedPercent: number): string =>
  [
    `${bold('Upstream secondary used')}:`,
    formatProgressPercent(upstreamUsedPercent),
    '',
    'Not enough usage data yet. The limit probably just reset, so go make some requests.',
  ].join('\n');

export const formatUsageLeaderboard = (report: UsageLeaderboardReport): string => [
  `${blockTitle('Leaderboard')} ${bold(`${report.days}d`)}`,
  label('Window', `${code(report.startAt)} -> ${code(report.endAt)}`),
  label('Exported', code(formatTimestamp(report.exportedAt))),
  '',
  blockTitle('By token usage'),
  ...formatLeaderboardRows(report.byTokens, 'tokens', report),
  '',
  blockTitle('By cost'),
  ...formatLeaderboardRows(report.byCost, 'cost', report),
  '',
  blockTitle('By cache %'),
  ...formatLeaderboardRows(report.byCachePercent, 'cachePercent', report),
].join('\n');

const formatLeaderboardRows = (
  entries: readonly UsageLeaderboardEntry[],
  metric: 'tokens' | 'cost' | 'cachePercent',
  report: UsageLeaderboardReport,
): string[] => {
  if (entries.length === 0) return ['No usage in this window.'];
  return entries.map((entry, index) =>
    `${index + 1}. ${bold(entry.username)} - ${formatLeaderboardMetric(entry, metric)} | ${formatLeaderboardShare(entry, metric, report)}`);
};

const formatLeaderboardMetric = (
  entry: UsageLeaderboardEntry,
  metric: 'tokens' | 'cost' | 'cachePercent',
): string => {
  switch (metric) {
  case 'tokens':
    return `${bold(formatNumber(tokenTotal(entry.totals.tokens)))} tokens`;
  case 'cost':
    return bold(formatMoney(entry.totals.cost));
  case 'cachePercent':
    return `${bold(formatPercent(entry.cachePercent))} cache`;
  }
};

const formatLeaderboardShare = (
  entry: UsageLeaderboardEntry,
  metric: 'tokens' | 'cost' | 'cachePercent',
  report: UsageLeaderboardReport,
): string => {
  switch (metric) {
  case 'tokens':
    return bold(formatPercent(sharePercent(tokenTotal(entry.totals.tokens), report.totals.tokens)));
  case 'cost':
    return bold(formatPercent(sharePercent(entry.totals.cost, report.totals.cost)));
  case 'cachePercent':
    return `${bold(formatPercent(sharePercent(entry.totals.tokens.input_cache_read ?? 0, report.totals.cacheReadTokens)))} cached share`;
  }
};

const sharePercent = (value: number, total: number): number | null =>
  total > 0 ? (value / total) * 100 : null;

const codexQuotaForDisplay = (upstream: UpstreamRecord): UpstreamRecord['codex_quota'] =>
  upstream.provider === 'codex' ? upstream.codex_quota ?? null : null;

const formatDurationUntil = (value: string, now = new Date()): string => {
  const end = new Date(value);
  if (!Number.isFinite(end.getTime())) return 'n/a';
  const totalMinutes = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 60_000));
  if (totalMinutes === 0) return 'now';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourUnit = hours === 1 ? 'hour' : 'hours';
  if (hours === 0) return `${minutes} min`;
  return `${formatNumber(hours)} ${hourUnit} ${minutes} min`;
};

const formatModelsCache = (upstream: UpstreamRecord): string => {
  const cache = upstream.modelsCache;
  if (!cache) return 'not reported';
  const fetched = cache.fetchedAt ? code(formatTimestamp(cache.fetchedAt)) : 'never';
  const lastError = cache.lastError ? `, last error ${code(cache.lastError.message)} at ${code(formatTimestamp(cache.lastError.at))}` : '';
  return `fetched ${fetched}${lastError}`;
};

const stringifyCompact = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 1200);
