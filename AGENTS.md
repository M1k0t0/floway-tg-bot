# AGENTS.md

## Hard Rules

- Do not open a Pull Request without explicit human approval. The human must
  understand the goal and risk, read the AI-generated code and PR text, and
  believe code, docs, and tests are internally consistent.
- Do not create commits on the main branch unless the human explicitly asks
  for a commit. Inside a git worktree (any non-main branch), commit every
  change immediately and autonomously; do not ask first, and do not leave
  in-flight work uncommitted.
- Give every task branch and worktree a meaningful name beginning with
  `floway-tg-bot/`; replace generated or random names before doing substantive
  work.
- Before claiming work is complete, run the relevant verification command and
  read the result. Worktree commits are the exception: commit them directly
  without running any test, lint, or typecheck first. Verification belongs to
  the completion and merge-to-main gate, not to each in-flight worktree
  commit.
- This file describes only the current system. Removed concepts must not
  appear anywhere in the repo: code, comments, tests, docs, this file
  included. Do not write notes that name dead concepts; their absence from
  the working tree is the statement.
- Keep `AGENTS.md` and `CLAUDE.md` aligned with each other and with the real
  architecture. When behavior changes, rewrite the relevant section; do not
  accrete contradictory notes.

## Project

`floway-tg-bot` is a Telegram bot for Floway users. It lets a Telegram user
bind a Floway account, manage that user's Floway API keys, inspect allowed
upstreams, view usage/quota details, view leaderboard summaries, and receive
private quota-window refresh notifications.

Stack: TypeScript, Node.js, Telegraf, `node:sqlite`, pnpm, Vitest, ESLint.
The production runtime is a long-running Node process. `dist/` is generated
by the TypeScript build and must not be edited by hand.

This bot is not the Floway gateway. It calls Floway's HTTP APIs and must keep
Floway's permission model intact. User-facing upstream, usage, quota, and
key-management surfaces must be scoped to the bound Floway user unless a
Floway endpoint explicitly returns a user-specific view. Admin export data is
allowed only as a backend data source and must be filtered before display.

## Layout

```text
floway-tg-bot/
├── src/
│   ├── index.ts                    # process bootstrap, Telegraf launch/shutdown, notifier lifecycle
│   ├── bot.ts                      # Telegram command registration and command handlers
│   ├── config.ts                   # environment parsing and defaults
│   ├── floway-client.ts            # Floway HTTP client and response validation
│   ├── db.ts                       # SQLite runtime store and binding/outbox operations
│   ├── db-constraints.ts           # constraints shared by runtime storage and schema DDL
│   ├── db-migrations/              # ordered startup migrations and canonical schema verification
│   ├── quota-window.ts             # normalized quota observations and window transition classification
│   ├── usage.ts                    # usage aggregation and quota estimate calculations
│   ├── format.ts                   # Telegram HTML formatting helpers
│   ├── quota-window-notifier.ts    # selected quota-window polling and notification logic
│   ├── deeplink.ts                 # Telegram /start bind payload helpers
│   ├── make-bind-link.ts           # CLI for bind links
│   └── types.ts                    # shared Floway and bot types
├── test/                           # Vitest coverage for bot, client, usage, format, notifier
├── data/                           # local SQLite data; gitignored
└── dist/                           # generated build output; gitignored
```

## Command Surface

Visible Telegram commands are documented in `README.md` and registered from
`src/bot.ts`. Binding, upstream, key, usage, quota, and leaderboard
operations are private-chat only.

When adding or changing commands:

- Update tests for authorization, binding state, formatting, and Floway client
  calls.
- Update `README.md` only for visible user commands.
- Keep diagnostic commands out of Telegram's command menu unless the user
  explicitly asks to expose them.
- Preserve Floway upstream access checks. A bound user must not see upstreams
  outside their Floway `upstreamIds` restriction.

## Quota Window Notifications

`src/quota-window-notifier.ts` polls available upstreams and sends each
eligible bound user a private notification when a usable upstream's selected
quota window advances.

Important invariants:

- Resolve the `premium` active-limit snapshot independently from provider window
  slots. Within the eligible snapshot, parse both `primary_*` and `secondary_*`
  fields and select the valid window whose exact `reset_after_at` is latest;
  equal resets prefer the longer duration. Never use the slot label as the
  reporting-window identity.
- Normalize provider timestamps to exact instants. Classify observations against an
  immutable anchor with a duration-relative tolerance capped at five hours; tolerated
  drift updates observation metadata but never moves the anchor.
- Create refresh events only after two matching provider observations. Missing,
  malformed, stale, or ambiguous quota data must not synthesize elapsed windows or
  erase the last valid cursor. A provider slot relabel with the same normalized facts
  is the same observation and must not restart confirmation.
- Treat a new window that starts inside the stored window and extends past it
  as an upstream early/manual refresh. Report the stored window truncated at
  the new start and include an explicit notification note.
- Commit cursor advancement, immutable event data, and eligible delivery outbox
  rows in one SQLite transaction. Expiring leases make abandoned deliveries
  reclaimable, while claim tokens fence state changes by competing workers. Renew
  ownership immediately before each bounded Telegram request. Delivery remains
  at-least-once: a crash after Telegram accepts a message can duplicate it.
- Quota estimates in notifications are estimates only; they derive from
  upstream-level hourly usage and raw token totals, and are not exact per-user quota
  accounting.

## Database Migrations

`src/db-migrations/` contains contiguous numbered migrations. `BindingStore`
automatically compares `PRAGMA user_version` with the compiled registry during
startup and applies every missing migration in order before the bot or notifier
starts. Each migration and its version update share one `BEGIN IMMEDIATE`
transaction; failures roll back and abort startup.

Do not add or require a manual migration command. Before deploying a schema
change, back up the SQLite database, build the application, and restart it
normally. Add a new numbered migration rather than editing an already-released
migration.

## Data And Secrets

Environment variables are documented in `.env.example`:

```bash
TELEGRAM_BOT_TOKEN=
FLOWAY_BASE_URL=http://localhost:8788
FLOWAY_ADMIN_KEY=
BOT_DB_PATH=./data/bot.sqlite
BOT_SECRET_KEY=
USAGE_EXPORT_CACHE_TTL_SECONDS=30
QUOTA_WINDOW_NOTIFY_INTERVAL_SECONDS=300
```

Generate `BOT_SECRET_KEY` with `openssl rand -base64 32`. Floway sessions are
encrypted locally with that key. Never commit `.env`, `data/`, SQLite files,
or production secrets. Do not delete or replace the production SQLite DB
unless the user explicitly asks and understands that bindings and notification
state live there.

## Verification

Run from the repo root:

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm build
corepack pnpm start
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
```

For targeted work, prefer focused commands first, then broaden before
completion when the change has shared behavior:

```bash
./node_modules/.bin/vitest run test/db-migrations.test.ts test/db.test.ts --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/vitest run test/quota-window-notifier.test.ts --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/vitest run test/format.test.ts --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false
./node_modules/.bin/tsc -p tsconfig.build.json --pretty false
```

Use `corepack pnpm build` before production deployment so `dist/` matches
`src/`. Generated `dist/` changes are not source changes.

## Deployment

There is no repository-owned production deploy script. Production is expected
to run the built Node entry (`node --no-warnings dist/index.js`) under a
process manager such as systemd.

Do not deploy, restart, or stop the production bot unless the user explicitly
asks. When deployment is requested, announce that the restart/deploy is
starting, build first, preserve `.env` and `BOT_DB_PATH`, and let shutdown
complete so the quota-window notifier finishes any active poll before the
SQLite store is closed.
