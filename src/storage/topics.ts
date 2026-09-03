import { query } from '../db/pool.js';
import type { Source, Topic } from '../core/models/index.js';
import { mapSource, mapTopic } from './rows.js';

export async function listTopics(userId: string): Promise<Array<Topic & { sourceCount: number }>> {
  const res = await query(
    `SELECT t.*, count(ts.source_id)::int AS source_count
     FROM topics t
     LEFT JOIN topic_sources ts ON ts.topic_id = t.id
     WHERE t.user_id = $1
     GROUP BY t.id
     ORDER BY t.created_at ASC`,
    [userId],
  );
  return res.rows.map((r) => ({ ...mapTopic(r), sourceCount: r.source_count }));
}

export async function getTopic(userId: string, id: string): Promise<Topic | null> {
  const res = await query('SELECT * FROM topics WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] ? mapTopic(res.rows[0]) : null;
}

export async function getTopicByName(userId: string, name: string): Promise<Topic | null> {
  const res = await query('SELECT * FROM topics WHERE user_id = $1 AND name = $2', [userId, name]);
  return res.rows[0] ? mapTopic(res.rows[0]) : null;
}

export async function countTopics(userId: string): Promise<number> {
  const res = await query('SELECT count(*)::int AS n FROM topics WHERE user_id = $1', [userId]);
  return res.rows[0]!.n;
}

export async function createTopic(userId: string, name: string): Promise<Topic> {
  const res = await query(
    `INSERT INTO topics (user_id, name) VALUES ($1, $2) RETURNING *`,
    [userId, name],
  );
  return mapTopic(res.rows[0]);
}

export async function renameTopic(userId: string, id: string, name: string): Promise<boolean> {
  const res = await query(
    `UPDATE topics SET name = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, name],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteTopic(userId: string, id: string): Promise<boolean> {
  const res = await query('DELETE FROM topics WHERE id = $1 AND user_id = $2', [id, userId]);
  return (res.rowCount ?? 0) > 0;
}

// Both topic and source must belong to the user (enforced in the query).
export async function addSourceToTopic(
  userId: string,
  topicId: string,
  sourceId: string,
): Promise<boolean> {
  const res = await query(
    `INSERT INTO topic_sources (topic_id, source_id)
     SELECT t.id, s.id FROM topics t, sources s
     WHERE t.id = $2 AND s.id = $3 AND t.user_id = $1 AND s.user_id = $1
     ON CONFLICT DO NOTHING`,
    [userId, topicId, sourceId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function removeSourceFromTopic(
  userId: string,
  topicId: string,
  sourceId: string,
): Promise<boolean> {
  const res = await query(
    `DELETE FROM topic_sources ts
     USING topics t
     WHERE ts.topic_id = t.id AND t.user_id = $1
       AND ts.topic_id = $2 AND ts.source_id = $3`,
    [userId, topicId, sourceId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getTopicIdsForSource(userId: string, sourceId: string): Promise<string[]> {
  const res = await query(
    `SELECT ts.topic_id FROM topic_sources ts
     JOIN topics t ON t.id = ts.topic_id
     WHERE ts.source_id = $1 AND t.user_id = $2`,
    [sourceId, userId],
  );
  return res.rows.map((r) => r.topic_id as string);
}

export async function getTopicSources(userId: string, topicId: string): Promise<Source[]> {
  const res = await query(
    `SELECT s.* FROM sources s
     JOIN topic_sources ts ON ts.source_id = s.id
     WHERE ts.topic_id = $1 AND s.user_id = $2
     ORDER BY s.added_at DESC`,
    [topicId, userId],
  );
  return res.rows.map(mapSource);
}
