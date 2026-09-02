# Telegram Ingestor

Collects messages from Telegram channels (public **and** private) into PostgreSQL,
managed via a Telegram bot, and exposes a read-only HTTP API + CLI for external
automation (e.g. Codex). Multi-tenant: each user has an isolated set of channels,
topics, and messages.

- **Stack:** Node.js + TypeScript, PostgreSQL, Docker Compose.
- **Telegram reading:** per-user MTProto sessions ([teleproto](https://www.npmjs.com/package/teleproto)), encrypted at rest.
- **Bot:** management interface (channels, topics, tokens) via [grammy](https://grammy.dev).
- **API:** read-only, per-user Bearer tokens, keyset pagination.
- **Retention:** messages partitioned by month; anything older than 3 months is dropped.

## Architecture

```
sources/telegram/  ── MTProto connector, login flow, mappers (Telegram-specific)
        │ implements
core/    ── source-agnostic domain (models, ports, ingestion pipeline)
        │ used by
storage/ ── PostgreSQL repositories (every query scoped by user_id)
api/     ── Fastify read-only API (Bearer auth)
bot/     ── grammy bot + one-time login web form
workers/ ── ingestor: lease-claims sessions, polls channels, isolates errors
maintenance/ ── monthly partition creation + retention (DROP old partitions)
cli/     ── thin client over the HTTP API
```

Two deployable services share one image (`Dockerfile`):

- **app** — bot + read API + login web endpoint (host-bound, proxied by Caddy).
- **ingestor** — MTProto workers + maintenance scheduler.

New sources can be added later as `sources/<name>/` implementing `SourceConnector`;
`core`, `storage`, and `api` stay unchanged.

## Prerequisites

- A Linux host with Docker + Docker Compose.
- Telegram **API credentials** from <https://my.telegram.org> (`api_id`, `api_hash`).
- A **bot token** from [@BotFather](https://t.me/BotFather).
- A public HTTPS entry point. This project assumes you already run **Caddy** and
  reverse-proxy a domain to the `app` container.

## Setup

```bash
cp .env.example .env
# Generate secrets:
openssl rand -hex 32   # -> MASTER_KEY
openssl rand -hex 24   # -> LOGIN_LINK_SECRET
# Fill in TELEGRAM_API_ID/HASH, BOT_TOKEN, POSTGRES_PASSWORD, PUBLIC_BASE_URL, BOT_ALLOWLIST
```

Key variables (see `.env.example` for all):

| Variable | Purpose |
|----------|---------|
| `PUBLIC_BASE_URL` | Public URL Caddy exposes (used for login links & `/apiinfo`) |
| `MASTER_KEY` | 32-byte hex key encrypting MTProto sessions at rest |
| `LOGIN_LINK_SECRET` | HMAC secret for one-time login links |
| `BOT_ALLOWLIST` | Comma-separated Telegram user IDs allowed to use the bot (empty = open) |
| `RETENTION_DAYS` | Retention window (default 90) |

## Run

```bash
docker compose up -d --build
```

Compose starts `postgres`, runs `migrate` (one-shot), then `app` and `ingestor`.
Migrations run automatically before the app starts.

Health checks:

```bash
curl http://127.0.0.1:8080/health   # -> {"status":"ok"}
curl http://127.0.0.1:8080/ready    # -> 200 when DB reachable
```

### Caddy reverse proxy

The `app` container binds to `127.0.0.1:8080` on the host. Point your existing
Caddy at it:

```caddy
ingest.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Both `/v1/*` (API) and `/login/*` (account login) are served by the `app` container.

## Using the bot

1. `/start` — register (must be in `BOT_ALLOWLIST` if set).
2. `/login` — opens a **one-time secure web page** to connect your Telegram
   account. You enter phone, code, and 2FA there — **not** in the chat, because
   Telegram invalidates login codes sent inside Telegram messages.
3. `/add @channel` or `/add https://t.me/+inviteHash` — track a channel
   (optionally `/add @channel | My Topic`).
4. `/topics`, `/newtopic`, `/addtotopic` — organize channels into topics.
5. `/channels`, `/status` — see sync state.
6. `/token` — create an API token (shown once). `/apiinfo` — access details.

## Read-only API

All endpoints require `Authorization: Bearer <token>` and are scoped to that
user. Responses are JSON; message lists use keyset pagination (`next_cursor`).

| Endpoint | Description |
|----------|-------------|
| `GET /v1/sources[?topic=<id>]` | List tracked sources + sync status |
| `GET /v1/sources/:id` | One source |
| `GET /v1/topics`, `GET /v1/topics/:id` | Topics and their sources |
| `GET /v1/messages` | List messages (see filters below) |
| `GET /v1/messages/:id` | One message |

`/v1/messages` filters:

- `channel` / `source_id` — filter by source
- `topic` — filter by topic
- `from`, `to` — `published_at` window (ISO 8601)
- `after_seq` — incremental: messages ingested after a given `ingest_seq`
- `limit` (default 100, max 500), `cursor` — pagination

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://ingest.example.com/v1/messages?from=2026-08-01T00:00:00Z&limit=100"
```

**Incremental pulls (Codex):** save the highest `ingest_seq` you've seen, then
poll `?after_seq=<seq>` to fetch only new messages, following `next_cursor`.

## CLI

The CLI is a thin wrapper over the same API.

```bash
export INGEST_API_URL=https://ingest.example.com
export INGEST_TOKEN=<token>

npx ingest-cli sources
npx ingest-cli topics
npx ingest-cli messages --from 2026-08-01T00:00:00Z --limit 50
npx ingest-cli messages --after-seq 12345 --all   # stream all new as NDJSON
npx ingest-cli get <message-id>
```

## Security & multi-tenancy

- Bot identity comes from the Telegram `user_id` (Bot API, unforgeable); an
  allowlist gates access.
- MTProto sessions are encrypted with AES-256-GCM (`MASTER_KEY`), never logged.
- API tokens are stored only as SHA-256 hashes; every query is scoped by
  `user_id`, so cross-tenant access is impossible by construction.
- Login links are HMAC-signed and expire in 10 minutes.
- No secrets in the repo — everything via environment variables.

## Resilience

- **Restart:** all state (sessions, sources, cursors) lives in PostgreSQL.
  Workers claim sessions via a DB lease; a crashed worker's lease expires and
  another worker takes over.
- **Deduplication:** unique `(source_id, external_message_id, published_at)` with
  `ON CONFLICT DO NOTHING` — re-processing is safe and idempotent.
- **Telegram outage:** teleproto auto-reconnects; the worker retries next tick.
- **Per-channel errors:** isolated with exponential backoff; other channels keep syncing.
- **PostgreSQL blips:** pooled connections retry; idempotent writes make retries safe.
- **Live channel changes:** the worker re-reads each user's sources every tick.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test            # unit + integration (integration needs Docker running)
npm run dev:app     # run the app with tsx watch
npm run dev:ingestor
```

Integration tests use [testcontainers](https://testcontainers.com) and require a
running Docker daemon. On OrbStack/Colima the socket is auto-detected from the
active `docker context`.

## Scaling

The ingestor is shard-ready: run multiple `ingestor` replicas and they will
split the session set via DB leases (`MAX_USERS_PER_WORKER` per worker). Quotas
(`user_quotas`) and a `plan` column on `users` are in place for future tiers.
