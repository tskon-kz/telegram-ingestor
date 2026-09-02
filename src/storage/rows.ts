import type {
  Message,
  Source,
  Topic,
  User,
  UserQuotas,
} from '../core/models/index.js';

export function mapUser(r: any): User {
  return {
    id: r.id,
    telegramUserId: BigInt(r.telegram_user_id),
    username: r.username,
    status: r.status,
    plan: r.plan,
    createdAt: r.created_at,
  };
}

export function mapQuotas(r: any): UserQuotas {
  return {
    userId: r.user_id,
    maxChannels: r.max_channels,
    maxTopics: r.max_topics,
  };
}

export function mapSource(r: any): Source {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    externalId: r.external_id,
    title: r.title,
    username: r.username,
    isPrivate: r.is_private,
    joinStatus: r.join_status,
    cursorMessageId: r.cursor_message_id == null ? null : BigInt(r.cursor_message_id),
    syncStatus: r.sync_status,
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    backoffUntil: r.backoff_until,
    telegramMeta: r.telegram_meta ?? {},
    addedAt: r.added_at,
  };
}

export function mapTopic(r: any): Topic {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    createdAt: r.created_at,
  };
}

export function mapMessage(r: any): Message {
  return {
    id: r.id,
    userId: r.user_id,
    sourceId: r.source_id,
    sourceType: r.source_type,
    externalMessageId: BigInt(r.external_message_id),
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
    ingestSeq: String(r.ingest_seq),
    text: r.text,
    links: r.links ?? [],
    metadata: r.metadata ?? {},
    rawPayload: r.raw_payload ?? {},
    contentHash: r.content_hash,
  };
}
