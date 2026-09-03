import { listSources } from '../../storage/sources.js';
import { listTopics } from '../../storage/topics.js';
import type { Source, Topic } from '../../core/models/index.js';

// callback_data is limited to 64 bytes, so we key buttons by an 8-char id
// prefix and resolve it back per user (same prefix-match idiom as /revoketoken).
export const SHORT_ID_LEN = 8;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LEN);
}

export async function findSourceByShortId(
  userId: string,
  code: string,
): Promise<Source | null> {
  const sources = await listSources(userId);
  return sources.find((s) => s.id.startsWith(code)) ?? null;
}

export async function findTopicByShortId(
  userId: string,
  code: string,
): Promise<(Topic & { sourceCount: number }) | null> {
  const topics = await listTopics(userId);
  return topics.find((t) => t.id.startsWith(code)) ?? null;
}
