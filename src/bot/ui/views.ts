import { InlineKeyboard, Keyboard } from 'grammy';
import type { Source } from '../../core/models/index.js';
import { listSources } from '../../storage/sources.js';
import { getSessionMeta } from '../../storage/sessions.js';
import { getTopicIdsForSource, getTopicSources, listTopics } from '../../storage/topics.js';
import { shortId } from './ids.js';

export interface View {
  text: string;
  reply_markup: InlineKeyboard;
}

const SYNC_EMOJI: Record<string, string> = {
  idle: '✅',
  syncing: '🔄',
  error: '⚠️',
  paused: '⏸️',
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function channelLabel(s: Source): string {
  const name = s.title ?? (s.username ? `@${s.username}` : s.externalId);
  return `${SYNC_EMOJI[s.syncStatus] ?? '•'} ${name}`;
}

export function formatSource(s: Source): string {
  const handle = s.username ? `@${s.username}` : s.externalId;
  return (
    `<b>${escapeHtml(s.title ?? handle)}</b>\n` +
    `${handle} · ${s.isPrivate ? 'private' : 'public'} · sync: ${s.syncStatus}` +
    (s.lastError ? `\n⚠️ ${escapeHtml(s.lastError)}` : '')
  );
}

// Persistent bottom keyboard shown with the main menu.
export function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text('🗂 Categories')
    .row()
    .text('👤 Account')
    .text('⚙️ More')
    .resized()
    .persistent();
}

export function mainMenuText(): string {
  return (
    '🏠 <b>Main menu</b>\n\n' +
    'Channels live inside categories — open a category to view, add or edit its channels.\n' +
    '🗂 Categories · 👤 Account · ⚙️ More'
  );
}

// Inline mirror of the reply keyboard, for "Back to menu" navigation.
export function menuInlineView(): View {
  const kb = new InlineKeyboard()
    .text('🗂 Categories', 'tp:list')
    .row()
    .text('👤 Account', 'acct:home')
    .text('⚙️ More', 'more:home');
  return { text: mainMenuText(), reply_markup: kb };
}

function backTo(cb: string, label = '⬅️ Back'): InlineKeyboard {
  return new InlineKeyboard().text(label, cb);
}

// Channel detail is always opened within a category; Back returns there.
export async function channelDetailView(
  source: Source,
  topic: { id: string; name: string },
): Promise<View> {
  const sShort = shortId(source.id);
  const tShort = shortId(topic.id);
  const otherIds = (await getTopicIdsForSource(source.userId, source.id)).filter(
    (id) => id !== topic.id,
  );
  const alsoIn =
    otherIds.length > 0 ? `\n\nAlso in ${otherIds.length} other categor${otherIds.length === 1 ? 'y' : 'ies'}.` : '';
  const kb = new InlineKeyboard()
    .text('🗑 Remove from category', `ch:rm:${sShort}:${tShort}`)
    .row()
    .text('⬅️ Back', `tp:view:${tShort}`);
  return { text: formatSource(source) + alsoIn, reply_markup: kb };
}

export function confirmView(text: string, confirmCb: string, cancelCb: string): View {
  const kb = new InlineKeyboard()
    .text('⚠️ Confirm', confirmCb)
    .text('Cancel', cancelCb);
  return { text, reply_markup: kb };
}

export async function topicsView(userId: string): Promise<View> {
  const topics = await listTopics(userId);
  const kb = new InlineKeyboard().text('➕ New category', 'tp:new').row();
  for (const t of topics) {
    kb.text(`🗂 ${t.name} · ${t.sourceCount}`, `tp:view:${shortId(t.id)}`).row();
  }
  const text =
    topics.length === 0
      ? '🗂 <b>Categories</b>\n\nNo categories yet. Tap ➕ to create one.'
      : `🗂 <b>Categories</b> (${topics.length})\n\nTap a category to manage it.`;
  return { text, reply_markup: kb };
}

export async function topicDetailView(
  userId: string,
  topic: { id: string; name: string },
): Promise<View> {
  const sources = await getTopicSources(userId, topic.id);
  const short = shortId(topic.id);
  const kb = new InlineKeyboard().text('➕ Add channel here', `tp:addch:${short}`).row();
  for (const s of sources) {
    kb.text(channelLabel(s), `ch:view:${shortId(s.id)}:${short}`).row();
  }
  kb.text('🔗 Manage channels', `tp:manage:${short}`)
    .row()
    .text('✏️ Rename', `tp:rename:${short}`)
    .text('🗑 Delete', `tp:del:${short}`)
    .row()
    .text('⬅️ Back', 'tp:list');
  const hint =
    sources.length === 0
      ? 'No channels here yet. Tap ➕ to add one.'
      : 'Tap a channel to view or edit it.';
  const text = `🗂 <b>${escapeHtml(topic.name)}</b> (${sources.length})\n\n${hint}`;
  return { text, reply_markup: kb };
}

export async function manageChannelsView(
  userId: string,
  topic: { id: string; name: string },
): Promise<View> {
  const [all, inTopic] = await Promise.all([
    listSources(userId),
    getTopicSources(userId, topic.id),
  ]);
  const member = new Set(inTopic.map((s) => s.id));
  const tShort = shortId(topic.id);
  const kb = new InlineKeyboard();
  for (const s of all) {
    const mark = member.has(s.id) ? '✅' : '⬜';
    const name = s.title ?? (s.username ? `@${s.username}` : s.externalId);
    kb.text(`${mark} ${name}`, `tp:tog:${tShort}:${shortId(s.id)}`).row();
  }
  kb.text('⬅️ Back', `tp:view:${tShort}`);
  const text =
    all.length === 0
      ? `🔗 <b>${escapeHtml(topic.name)}</b>\n\nNo channels yet. Add channels first.`
      : `🔗 <b>${escapeHtml(topic.name)}</b>\n\nTap a channel to add/remove it from this category.`;
  return { text, reply_markup: kb };
}

// Account view needs the freshly-signed login URL from the caller.
export async function accountView(
  userId: string,
  loginUrl: string,
  feedUrl: string,
): Promise<View> {
  const [session, sources] = await Promise.all([
    getSessionMeta(userId),
    listSources(userId),
  ]);
  const status = session ? session.status : 'not connected';
  const text =
    '👤 <b>Account</b>\n\n' +
    `Connection: <b>${status}</b>\n` +
    `Channels: ${sources.length}`;
  const kb = new InlineKeyboard()
    .url('🔐 Connect', loginUrl)
    .url('📰 My feed', feedUrl)
    .row()
    .text('📊 Status', 'acct:status')
    .text('🔌 Disconnect', 'acct:logout')
    .row()
    .text('🔑 API & tokens', 'acct:api');
  return { text, reply_markup: kb };
}

export async function statusView(userId: string): Promise<View> {
  const [session, sources] = await Promise.all([
    getSessionMeta(userId),
    listSources(userId),
  ]);
  const lines = [
    '📊 <b>Sync status</b>',
    '',
    `Account: ${session ? session.status : 'not connected'}`,
    `Channels: ${sources.length}`,
    '',
    ...sources.map(
      (s) =>
        `${SYNC_EMOJI[s.syncStatus] ?? '•'} ${escapeHtml(s.title ?? s.externalId)} — ${s.syncStatus}` +
        (s.lastError ? ` (${escapeHtml(s.lastError)})` : ''),
    ),
  ];
  return { text: lines.join('\n'), reply_markup: backTo('acct:home') };
}
