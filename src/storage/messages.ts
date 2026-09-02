import { query } from '../db/pool.js';
import type { Message, NormalizedMessage } from '../core/models/index.js';
import { mapMessage } from './rows.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type Page,
} from './pagination.js';

export interface InsertContext {
  userId: string;
  sourceId: string;
}

// Idempotent: duplicate (source_id, external_message_id, published_at) rows are skipped.
export async function insertMessages(
  ctx: InsertContext,
  messages: NormalizedMessage[],
): Promise<{ inserted: number }> {
  if (messages.length === 0) return { inserted: 0 };

  const cols = 9;
  const values: unknown[] = [];
  const tuples: string[] = [];
  messages.forEach((m, i) => {
    const b = i * cols;
    tuples.push(
      `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7}::jsonb, $${b + 8}::jsonb, $${b + 9})`,
    );
    values.push(
      ctx.userId,
      ctx.sourceId,
      m.sourceType,
      m.externalMessageId.toString(),
      m.publishedAt,
      JSON.stringify(m.links ?? []),
      JSON.stringify(m.metadata ?? {}),
      JSON.stringify(m.rawPayload ?? {}),
      m.text,
    );
  });

  const res = await query(
    `INSERT INTO messages
       (user_id, source_id, source_type, external_message_id, published_at,
        links, metadata, raw_payload, text)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (source_id, external_message_id, published_at) DO NOTHING`,
    values,
  );
  return { inserted: res.rowCount ?? 0 };
}

export async function getMessage(userId: string, id: string): Promise<Message | null> {
  const res = await query('SELECT * FROM messages WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] ? mapMessage(res.rows[0]) : null;
}

export interface ListMessagesQuery {
  sourceId?: string;
  topicId?: string;
  from?: Date;
  to?: Date;
  afterSeq?: string;
  limit?: number;
  cursor?: string;
}

// afterSeq/incremental cursor => ascending by ingest_seq; otherwise descending
// by (published_at, id) within the optional from/to window.
export async function listMessages(
  userId: string,
  q: ListMessagesQuery,
): Promise<Page<Message>> {
  const limit = clampLimit(q.limit);
  const params: unknown[] = [userId];
  const where: string[] = ['m.user_id = $1'];

  if (q.sourceId) {
    params.push(q.sourceId);
    where.push(`m.source_id = $${params.length}`);
  }
  if (q.topicId) {
    params.push(q.topicId);
    where.push(
      `m.source_id IN (SELECT source_id FROM topic_sources WHERE topic_id = $${params.length})`,
    );
  }

  const incremental = q.afterSeq != null || isIncrementalCursor(q.cursor);
  let sql: string;

  if (incremental) {
    const seq = resolveAfterSeq(q);
    if (seq != null) {
      params.push(seq);
      where.push(`m.ingest_seq > $${params.length}`);
    }
    params.push(limit + 1);
    sql = `SELECT * FROM messages m WHERE ${where.join(' AND ')}
           ORDER BY m.ingest_seq ASC LIMIT $${params.length}`;
  } else {
    if (q.from) {
      params.push(q.from);
      where.push(`m.published_at >= $${params.length}`);
    }
    if (q.to) {
      params.push(q.to);
      where.push(`m.published_at < $${params.length}`);
    }
    const c = q.cursor ? decodeCursor<{ p: string; id: string }>(q.cursor) : null;
    if (c) {
      params.push(c.p, c.id);
      // keyset: strictly before the cursor in (published_at DESC, id DESC) order
      where.push(
        `(m.published_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit + 1);
    sql = `SELECT * FROM messages m WHERE ${where.join(' AND ')}
           ORDER BY m.published_at DESC, m.id DESC LIMIT $${params.length}`;
  }

  const res = await query(sql, params);
  const rows = res.rows.map(mapMessage);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1]!;
    nextCursor = incremental
      ? encodeCursor({ seq: last.ingestSeq })
      : encodeCursor({ p: last.publishedAt.toISOString(), id: last.id });
  }
  return { data, nextCursor };
}

function isIncrementalCursor(cursor?: string): boolean {
  if (!cursor) return false;
  const c = decodeCursor<{ seq?: string }>(cursor);
  return !!c && c.seq != null;
}

function resolveAfterSeq(q: ListMessagesQuery): string | null {
  if (q.cursor) {
    const c = decodeCursor<{ seq?: string }>(q.cursor);
    if (c?.seq != null) return c.seq;
  }
  return q.afterSeq ?? null;
}
