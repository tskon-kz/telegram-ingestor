import { query } from '../db/pool.js';
import type { JoinStatus, Source, SourceType, SyncStatus } from '../core/models/index.js';
import { mapSource } from './rows.js';

const SOURCES_CHANNEL = 'sources_changed';

async function notifySourcesChanged(userId: string): Promise<void> {
  // Best-effort; ingestor also polls as a fallback.
  await query(`SELECT pg_notify($1, $2)`, [SOURCES_CHANNEL, userId]).catch(() => undefined);
}

export interface NewSource {
  userId: string;
  type: SourceType;
  externalId: string;
  title: string | null;
  username: string | null;
  isPrivate: boolean;
  joinStatus: JoinStatus;
  telegramMeta: Record<string, unknown>;
}

export async function listSources(userId: string, topicId?: string): Promise<Source[]> {
  if (topicId) {
    const res = await query(
      `SELECT s.* FROM sources s
       JOIN topic_sources ts ON ts.source_id = s.id
       JOIN topics t ON t.id = ts.topic_id
       WHERE s.user_id = $1 AND t.id = $2 AND t.user_id = $1
       ORDER BY s.added_at DESC`,
      [userId, topicId],
    );
    return res.rows.map(mapSource);
  }
  const res = await query(
    `SELECT * FROM sources WHERE user_id = $1 ORDER BY added_at DESC`,
    [userId],
  );
  return res.rows.map(mapSource);
}

export async function getSource(userId: string, id: string): Promise<Source | null> {
  const res = await query('SELECT * FROM sources WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] ? mapSource(res.rows[0]) : null;
}

export async function countSources(userId: string): Promise<number> {
  const res = await query('SELECT count(*)::int AS n FROM sources WHERE user_id = $1', [userId]);
  return res.rows[0]!.n;
}

export async function createSource(input: NewSource): Promise<Source> {
  const res = await query(
    `INSERT INTO sources
       (user_id, type, external_id, title, username, is_private, join_status, telegram_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (user_id, type, external_id) DO UPDATE SET
       title = EXCLUDED.title,
       username = EXCLUDED.username,
       is_private = EXCLUDED.is_private,
       join_status = EXCLUDED.join_status,
       telegram_meta = EXCLUDED.telegram_meta
     RETURNING *`,
    [
      input.userId,
      input.type,
      input.externalId,
      input.title,
      input.username,
      input.isPrivate,
      input.joinStatus,
      JSON.stringify(input.telegramMeta),
    ],
  );
  await notifySourcesChanged(input.userId);
  return mapSource(res.rows[0]);
}

export async function deleteSource(userId: string, id: string): Promise<boolean> {
  const res = await query('DELETE FROM sources WHERE id = $1 AND user_id = $2', [id, userId]);
  if ((res.rowCount ?? 0) > 0) {
    await notifySourcesChanged(userId);
    return true;
  }
  return false;
}

export async function getSyncableSources(userId: string): Promise<Source[]> {
  const res = await query(
    `SELECT * FROM sources
     WHERE user_id = $1 AND join_status IN ('joined', 'accessible')
     ORDER BY added_at ASC`,
    [userId],
  );
  return res.rows.map(mapSource);
}

export async function updateCursor(sourceId: string, cursorMessageId: bigint): Promise<void> {
  await query(
    `UPDATE sources
     SET cursor_message_id = GREATEST(coalesce(cursor_message_id, 0), $2),
         last_synced_at = now(),
         sync_status = 'idle',
         last_error = NULL,
         backoff_until = NULL
     WHERE id = $1`,
    [sourceId, cursorMessageId.toString()],
  );
}

export async function markSyncStatus(
  sourceId: string,
  status: SyncStatus,
  opts: { lastError?: string | null; backoffUntil?: Date | null } = {},
): Promise<void> {
  await query(
    `UPDATE sources
     SET sync_status = $2,
         last_error = $3,
         backoff_until = $4,
         last_synced_at = CASE WHEN $2 = 'idle' THEN now() ELSE last_synced_at END
     WHERE id = $1`,
    [sourceId, status, opts.lastError ?? null, opts.backoffUntil ?? null],
  );
}

export { SOURCES_CHANNEL };
