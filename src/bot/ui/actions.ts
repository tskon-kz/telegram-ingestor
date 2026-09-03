// Framework-free business logic shared by slash commands and button callbacks.
// These return result objects; the caller decides how to render them.
import type { Source, Topic, User } from '../../core/models/index.js';
import { getQuotas } from '../../storage/users.js';
import { countSources, createSource, deleteSource } from '../../storage/sources.js';
import {
  addSourceToTopic,
  countTopics,
  createTopic,
  deleteTopic,
  getTopicByName,
  getTopicIdsForSource,
  removeSourceFromTopic,
  renameTopic,
} from '../../storage/topics.js';
import { NotLoggedInError, withUserConnector } from '../../sources/telegram/userSession.js';

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

export function loginAwareError(err: unknown, prefix: string): string {
  if (err instanceof NotLoggedInError) {
    return 'You need to connect your Telegram account first. Use 🔐 Connect (or /login).';
  }
  const msg = (err as any)?.errorMessage ?? (err as Error)?.message ?? String(err);
  return `${prefix}: ${msg}`;
}

// Resolve a channel ref (@username / invite link) and start tracking it,
// optionally attaching it to a topic. Mirrors the old /add command body.
export async function trackChannel(
  user: User,
  ref: string,
  topicId?: string,
): Promise<ActionResult<{ source: Source; note: string }>> {
  const quotas = await getQuotas(user.id);
  if ((await countSources(user.id)) >= quotas.maxChannels) {
    return { ok: false, error: `Channel limit reached (${quotas.maxChannels}).` };
  }

  let source: Source;
  try {
    const resolved = await withUserConnector(user.id, (c) => c.resolve(user.id, ref));
    source = await createSource({
      userId: user.id,
      type: 'telegram_channel',
      externalId: resolved.externalId,
      title: resolved.title,
      username: resolved.username,
      isPrivate: resolved.isPrivate,
      joinStatus: resolved.joinStatus,
      telegramMeta: resolved.telegramMeta,
    });
  } catch (err) {
    return { ok: false, error: loginAwareError(err, 'Could not add channel') };
  }

  let note = '';
  if (topicId) {
    await addSourceToTopic(user.id, topicId, source.id);
    note = ' (added to category)';
  }
  return { ok: true, value: { source, note } };
}

export async function removeChannel(userId: string, sourceId: string): Promise<boolean> {
  return deleteSource(userId, sourceId);
}

export async function makeTopic(user: User, name: string): Promise<ActionResult<Topic>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Category name cannot be empty.' };
  const quotas = await getQuotas(user.id);
  if ((await countTopics(user.id)) >= quotas.maxTopics) {
    return { ok: false, error: `Category limit reached (${quotas.maxTopics}).` };
  }
  if (await getTopicByName(user.id, trimmed)) {
    return { ok: false, error: 'A category with that name already exists.' };
  }
  const topic = await createTopic(user.id, trimmed);
  return { ok: true, value: topic };
}

export async function renameTopicTo(
  user: User,
  topicId: string,
  name: string,
): Promise<ActionResult<string>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Category name cannot be empty.' };
  const existing = await getTopicByName(user.id, trimmed);
  if (existing && existing.id !== topicId) {
    return { ok: false, error: 'A category with that name already exists.' };
  }
  await renameTopic(user.id, topicId, trimmed);
  return { ok: true, value: trimmed };
}

export async function removeTopic(userId: string, topicId: string): Promise<boolean> {
  return deleteTopic(userId, topicId);
}

// Remove a channel from a category. Channels must live in at least one
// category, so a channel left in none stops being tracked entirely.
export async function removeChannelFromCategory(
  userId: string,
  topicId: string,
  sourceId: string,
): Promise<{ untracked: boolean }> {
  await removeSourceFromTopic(userId, topicId, sourceId);
  const remaining = await getTopicIdsForSource(userId, sourceId);
  if (remaining.length === 0) {
    await deleteSource(userId, sourceId);
    return { untracked: true };
  }
  return { untracked: false };
}

// Link the channel to the topic if not linked, otherwise unlink it.
export async function toggleChannelInTopic(
  userId: string,
  topicId: string,
  sourceId: string,
  linked: boolean,
): Promise<void> {
  if (linked) {
    await removeChannelFromCategory(userId, topicId, sourceId);
  } else {
    await addSourceToTopic(userId, topicId, sourceId);
  }
}
