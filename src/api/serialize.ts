import type { Message, Source, Topic } from '../core/models/index.js';

export function serializeSource(s: Source) {
  return {
    id: s.id,
    type: s.type,
    external_id: s.externalId,
    title: s.title,
    username: s.username,
    is_private: s.isPrivate,
    join_status: s.joinStatus,
    sync_status: s.syncStatus,
    last_synced_at: s.lastSyncedAt,
    last_error: s.lastError,
    cursor_message_id: s.cursorMessageId?.toString() ?? null,
    added_at: s.addedAt,
  };
}

export function serializeTopic(t: Topic & { sourceCount?: number }) {
  return {
    id: t.id,
    name: t.name,
    source_count: t.sourceCount ?? undefined,
    created_at: t.createdAt,
  };
}

export function serializeMessage(m: Message) {
  return {
    id: m.id,
    source_id: m.sourceId,
    source_type: m.sourceType,
    external_message_id: m.externalMessageId.toString(),
    published_at: m.publishedAt,
    fetched_at: m.fetchedAt,
    ingest_seq: m.ingestSeq,
    text: m.text,
    links: m.links,
    metadata: m.metadata,
    content_hash: m.contentHash,
  };
}
