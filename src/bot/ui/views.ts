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
    .text('📡 Channels')
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
    'Use the buttons below to manage your channels and categories.\n' +
    '📡 Channels · 🗂 Categories · 👤 Account · ⚙️ More'
  );
}

// Inline mirror of the reply keyboard, for "Back to menu" navigation.
export function menuInlineView(): View {
  const kb = new InlineKeyboard()
    .text('📡 Channels', 'ch:list')
    .text('🗂 Categories', 'tp:list')
    .row()
    .text('👤 Account', 'acct:home')
    .text('⚙️ More', 'more:home');
  return { text: mainMenuText(), reply_markup: kb };
}

function backTo(cb: string, label = '⬅️ Back'): InlineKeyboard {
  return new InlineKeyboard().text(label, cb);
}

export async function channelsView(userId: string): Promise<View> {
  const sources = await listSources(userId);
  const kb = new InlineKeyboard().text('➕ Add channel', 'ch:add').row();
  for (const s of sources) {
    kb.text(channelLabel(s), `ch:view:${shortId(s.id)}`).row();
  }
  const text =
    sources.length === 0
      ? '📡 <b>Channels</b>\n\nNo channels tracked yet. Tap ➕ to add one.'
      : `📡 <b>Channels</b> (${sources.length})\n\nTap a channel to manage it.`;
  return { text, reply_markup: kb };
}

export async function channelDetailView(userId: string, source: Source): Promise<View> {
  const kb = new InlineKeyboard()
    .text('🗂 Add to category', `ch:cats:${shortId(source.id)}`)
    .row()
    .text('🗑 Remove', `ch:rm:${shortId(source.id)}`)
    .row()
    .text('⬅️ Back', 'ch:list');
  return { text: formatSource(source), reply_markup: kb };
}

// Toggle which categories a channel belongs to, from the channel side.
export async function channelCategoriesView(userId: string, source: Source): Promise<View> {
  const [topics, memberIds] = await Promise.all([
    listTopics(userId),
    getTopicIdsForSource(userId, source.id),
  ]);
  const member = new Set(memberIds);
  const kb = new InlineKeyboard();
  if (topics.length === 0) {
    kb.text('➕ New category', 'tp:new').row();
  }
  for (const t of topics) {
    const mark = member.has(t.id) ? '✅' : '⬜';
    kb.text(`${mark} ${t.name}`, `ch:link:${shortId(source.id)}:${shortId(t.id)}`).row();
  }
  kb.text('⬅️ Back', `ch:view:${shortId(source.id)}`);
  const title = source.title ?? source.externalId;
  const text =
    topics.length === 0
      ? `🗂 <b>${escapeHtml(title)}</b>\n\nNo categories yet. Create one first.`
      : `🗂 <b>${escapeHtml(title)}</b>\n\nTap a category to add/remove this channel.`;
  return { text, reply_markup: kb };
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
  const kb = new InlineKeyboard()
    .text('🔗 Manage channels', `tp:manage:${short}`)
    .row()
    .text('✏️ Rename', `tp:rename:${short}`)
    .text('🗑 Delete', `tp:del:${short}`)
    .row()
    .text('⬅️ Back', 'tp:list');
  const list =
    sources.length === 0
      ? 'No channels in this category yet.'
      : sources.map((s) => `• ${escapeHtml(s.title ?? s.externalId)}`).join('\n');
  const text = `🗂 <b>${escapeHtml(topic.name)}</b> (${sources.length})\n\n${list}`;
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
export async function accountView(userId: string, loginUrl: string): Promise<View> {
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
