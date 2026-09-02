/* eslint-disable */
export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- ---------------------------------------------------------------- users
    CREATE TABLE users (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      telegram_user_id  bigint NOT NULL UNIQUE,
      username          text,
      status            text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'blocked')),
      plan              text NOT NULL DEFAULT 'free',
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_quotas (
      user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      max_channels  integer NOT NULL DEFAULT 20,
      max_topics    integer NOT NULL DEFAULT 20
    );

    -- ------------------------------------------------------ telegram sessions
    CREATE TABLE telegram_sessions (
      user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_session  bytea NOT NULL,
      phone              text,
      tg_account_id      bigint,
      status             text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'needs_reauth', 'revoked')),
      owner_worker_id    text,
      lease_expires_at   timestamptz,
      last_authorized_at timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX telegram_sessions_lease_idx
      ON telegram_sessions (status, lease_expires_at);

    -- ------------------------------------------------------------- api tokens
    CREATE TABLE api_tokens (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    text NOT NULL UNIQUE,
      prefix        text NOT NULL,
      name          text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_used_at  timestamptz,
      revoked_at    timestamptz
    );
    CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

    -- ---------------------------------------------------------------- sources
    CREATE TABLE sources (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type               text NOT NULL DEFAULT 'telegram_channel',
      external_id        text NOT NULL,
      title              text,
      username           text,
      is_private         boolean NOT NULL DEFAULT false,
      join_status        text NOT NULL DEFAULT 'pending'
                           CHECK (join_status IN ('pending', 'joined', 'accessible', 'failed', 'left')),
      cursor_message_id  bigint,
      sync_status        text NOT NULL DEFAULT 'idle'
                           CHECK (sync_status IN ('idle', 'syncing', 'error', 'paused')),
      last_synced_at     timestamptz,
      last_error         text,
      backoff_until      timestamptz,
      telegram_meta      jsonb NOT NULL DEFAULT '{}'::jsonb,
      added_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, type, external_id)
    );
    CREATE INDEX sources_user_idx ON sources (user_id);

    -- ----------------------------------------------------------------- topics
    CREATE TABLE topics (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, name)
    );

    CREATE TABLE topic_sources (
      topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      PRIMARY KEY (topic_id, source_id)
    );
    CREATE INDEX topic_sources_source_idx ON topic_sources (source_id);

    -- --------------------------------------------------------------- messages
    CREATE SEQUENCE messages_ingest_seq;

    CREATE TABLE messages (
      id                   uuid NOT NULL DEFAULT gen_random_uuid(),
      user_id              uuid NOT NULL,
      source_id            uuid NOT NULL,
      source_type          text NOT NULL DEFAULT 'telegram_channel',
      external_message_id  bigint NOT NULL,
      published_at         timestamptz NOT NULL,
      fetched_at           timestamptz NOT NULL DEFAULT now(),
      ingest_seq           bigint NOT NULL DEFAULT nextval('messages_ingest_seq'),
      text                 text,
      links                jsonb NOT NULL DEFAULT '[]'::jsonb,
      metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
      content_hash         text,
      PRIMARY KEY (published_at, id),
      UNIQUE (source_id, external_message_id, published_at)
    ) PARTITION BY RANGE (published_at);

    ALTER SEQUENCE messages_ingest_seq OWNED BY messages.ingest_seq;

    CREATE INDEX messages_user_seq_idx ON messages (user_id, ingest_seq);
    CREATE INDEX messages_user_source_pub_idx
      ON messages (user_id, source_id, published_at DESC);
    CREATE INDEX messages_user_pub_idx ON messages (user_id, published_at DESC);

    -- Idempotent monthly-partition creator, used at bootstrap and by maintenance.
    CREATE OR REPLACE FUNCTION ensure_messages_partition(p_month date)
    RETURNS void LANGUAGE plpgsql AS $$
    DECLARE
      v_start date := date_trunc('month', p_month)::date;
      v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
      v_name  text := 'messages_' || to_char(v_start, 'YYYY_MM');
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
        v_name, v_start, v_end
      );
    END;
    $$;
  `);

  pgm.sql(`
    DO $$
    DECLARE i integer;
    BEGIN
      FOR i IN -4..2 LOOP
        PERFORM ensure_messages_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
      END LOOP;
    END;
    $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP FUNCTION IF EXISTS ensure_messages_partition(date);
    DROP TABLE IF EXISTS messages;
    DROP SEQUENCE IF EXISTS messages_ingest_seq;
    DROP TABLE IF EXISTS topic_sources;
    DROP TABLE IF EXISTS topics;
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS api_tokens;
    DROP TABLE IF EXISTS telegram_sessions;
    DROP TABLE IF EXISTS user_quotas;
    DROP TABLE IF EXISTS users;
  `);
}
