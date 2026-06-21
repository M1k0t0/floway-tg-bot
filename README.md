# Floway Telegram Bot

Telegram bot for Floway users to bind their Floway account, manage their own
API keys, inspect upstreams, and view Codex primary/secondary-window usage.

## Setup

```bash
corepack enable
corepack pnpm install
cp .env.example .env
openssl rand -base64 32
```

Fill `.env`, then run:

```bash
corepack pnpm dev
```

Production build:

```bash
corepack pnpm build
corepack pnpm start
```

## Commands

- `/bind <username> <password>`
- `/unbind`
- `/me`
- `/info`
- `/upstreams`
- `/upstream <upstream_id>`
- `/keys`
- `/newkey <name> [all|upstream_id[,upstream_id...]]`
- `/delkey <key_id>`
- `/rotatekey <key_id>`
- `/usage <upstream_id>`

Binding and key operations are private-chat only. Passwords are exchanged for a
Floway session and are never stored. Floway sessions are encrypted locally with
`BOT_SECRET_KEY`.

## Bind Deep Links

Telegram supports one-shot `/start` payload links. Generate a bind link with:

```bash
corepack pnpm bind-link <username-or-user-id> <password>
```

The link has this shape:

```text
https://t.me/<bot_username>?start=<payload>
```

Telegram limits the start payload to 64 characters after encoding, so this only
works for short usernames/user ids and passwords. If the generator reports the
payload is too long, use `/bind <username> <password>` instead.
