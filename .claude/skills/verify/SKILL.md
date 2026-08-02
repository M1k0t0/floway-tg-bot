---
name: verify
summary: Exercise Telegram command and notifier flows against disposable Floway and Telegram stubs.
---

# Verify

1. Install and build with `corepack pnpm install` and `corepack pnpm build`.
2. Run a disposable local HTTP server implementing Floway `/auth/login`, `/auth/me`, `/api/upstreams`, `/api/users`, and `/api/export` responses.
3. Preload Telegraf with `NODE_OPTIONS=--require=<stub.cjs>`; patch `ApiClient.prototype.callApi` to feed private-chat command updates and capture `sendMessage` payloads without contacting Telegram.
4. Start `dist/index.js` with a temporary `BOT_DB_PATH`, generated 32-byte `BOT_SECRET_KEY`, local `FLOWAY_BASE_URL`, and non-production credentials. Drive `/bind`, `/usage`, `/quota verbose`, and the hidden notifier diagnostic command.
5. For persistence changes, create a disposable version-0 SQLite file with the shipped `bindings` schema plus an unrelated sentinel table. Start the built app normally—never invoke a migration command—then inspect `user_version`, preserved bindings, empty current notifier tables, and the sentinel. Reopen the app and verify the migration is an idempotent no-op.
6. Create a disposable future-version or invalid-schema database and verify startup aborts without changing its version, tables, or rows.
7. For notifier changes, bind through the command surface, let the first provider observation seed the disposable cursor silently, then supply two matching advanced observations and capture the automatic Telegram message.

Never point this recipe at production Telegram, Floway, or SQLite data.