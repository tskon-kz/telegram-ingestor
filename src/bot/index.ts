import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { loadConfig } from '../config/index.js';
import { childLogger } from '../logging/index.js';
import { signPayload } from '../crypto/index.js';
import { portalUrl } from './portalSession.js';
import { upsertUser } from '../storage/users.js';
import { revokeSession, getSessionMeta } from '../storage/sessions.js';
import { listSources } from '../storage/sources.js';
import {
  addSourceToTopic,
  getTopic,
  getTopicByName,
  getTopicIdsForSource,
  listTopics,
  removeSourceFromTopic,
} from '../storage/topics.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../storage/tokens.js';
import type { User } from '../core/models/index.js';
import {
  makeTopic,
  removeChannel,
  removeChannelFromCategory,
  removeTopic,
  renameTopicTo,
  toggleChannelInTopic,
  trackChannel,
} from './ui/actions.js';
import { findSourceByShortId, findTopicByShortId } from './ui/ids.js';
import { clearPending, getPending, setPending } from './ui/state.js';
import type { View } from './ui/views.js';
import {
  accountView,
  channelDetailView,
  confirmView,
  feedLinkView,
  formatSource,
  mainMenuKeyboard,
  mainMenuText,
  manageChannelsView,
  menuInlineView,
  statusView,
  topicDetailView,
  topicsView,
} from './ui/views.js';

const log = childLogger({ mod: 'bot' });
const LOGIN_TTL_MS = 10 * 60 * 1000;

const HELP = `All commands:

/menu – open the main menu
/login – connect your Telegram account
/logout – disconnect your account

/add <@channel | invite-link | @bot> | <category> – track a channel or bot/dialog in a category
/remove <@username | id> – stop tracking a channel
/channels – list tracked channels + sync status
/status – sync status summary

/topics – list your categories
/newtopic <name> – create a category
/renametopic <name> | <new name>
/deltopic <name>
/addtotopic <channel> | <category>
/removefromtopic <channel> | <category>

/token [name] – create an API token (shown once)
/tokens – list your API tokens
/revoketoken <id> – revoke a token
/apiinfo – how to access your data via the API/CLI
/whoami – your account info
/cancel – abort the current action`;

// Commands surfaced in Telegram's command menu; the rest live under ⚙️ More.
const MENU_COMMANDS = [
  { command: 'menu', description: 'Open the main menu' },
  { command: 'feed', description: 'Open your personal feed' },
  { command: 'login', description: 'Connect your Telegram account' },
  { command: 'cancel', description: 'Abort the current action' },
  { command: 'help', description: 'Show all commands' },
];

async function currentUser(ctx: Context): Promise<User> {
  const from = ctx.from!;
  return upsertUser(BigInt(from.id), from.username ?? null);
}

export function createBot(): Bot {
  const cfg = loadConfig();
  const bot = new Bot(cfg.BOT_TOKEN);

  const loginUrl = (user: User): string => {
    const token = signPayload(user.id, cfg.LOGIN_LINK_SECRET, LOGIN_TTL_MS);
    return `${cfg.PUBLIC_BASE_URL}/app/login?t=${encodeURIComponent(token)}`;
  };

  const feedUrl = (user: User): string => portalUrl(user.id);

  const apiInfoText = (user: User): string =>
    `Your data is available via the read-only API (scoped to your account).\n\n` +
    `Base URL: ${cfg.PUBLIC_BASE_URL}\nUser ID: ${user.id}\n\n` +
    `1. Create a token: /token\n` +
    `2. Example:\n` +
    `curl -H "Authorization: Bearer &lt;token&gt;" "${cfg.PUBLIC_BASE_URL}/v1/messages?limit=50"\n\n` +
    `Endpoints: /v1/sources, /v1/topics, /v1/messages, /v1/messages/:id\n` +
    `CLI: INGEST_API_URL=${cfg.PUBLIC_BASE_URL} INGEST_TOKEN=&lt;token&gt; ingest-cli messages`;

  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (cfg.BOT_ALLOWLIST.length > 0 && !cfg.BOT_ALLOWLIST.includes(BigInt(ctx.from.id))) {
      await ctx.reply('⛔ You are not authorized to use this bot.');
      return;
    }
    await next();
  });

  // --- Core menu commands ---

  bot.command('start', async (ctx) => {
    await currentUser(ctx);
    await ctx.reply(
      'Welcome! This bot collects messages from your Telegram channels.\n\n' + mainMenuText(),
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() },
    );
  });

  bot.command('menu', async (ctx) => {
    await currentUser(ctx);
    await ctx.reply(mainMenuText(), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command('help', async (ctx) => ctx.reply(HELP));

  bot.command('cancel', async (ctx) => {
    const user = await currentUser(ctx);
    clearPending(user.id);
    await ctx.reply('Cancelled.', { reply_markup: mainMenuKeyboard() });
  });

  bot.command('feed', async (ctx) => {
    const user = await currentUser(ctx);
    clearPending(user.id);
    await sendView(ctx, feedLinkView(feedUrl(user)));
  });

  bot.command('login', async (ctx) => {
    const user = await currentUser(ctx);
    await ctx.reply(
      'Open the secure login page to connect your Telegram account. ' +
        'Enter the code there (not here) — Telegram invalidates codes sent in chats.\n\n' +
        'This link is valid for 10 minutes.',
      { reply_markup: new InlineKeyboard().url('🔐 Open login page', loginUrl(user)) },
    );
  });

  bot.command('logout', async (ctx) => {
    const user = await currentUser(ctx);
    await revokeSession(user.id);
    await ctx.reply('Disconnected. Your session was removed.');
  });

  // --- Channel commands (kept for power users; UI mirrors these) ---

  bot.command('add', async (ctx) => {
    const user = await currentUser(ctx);
    const [refPart, topicName] = splitPipe(commandArg(ctx));
    if (!refPart || !topicName) {
      return ctx.reply(
        'Usage: /add <@channel | invite-link | @bot> | <category>\n' +
          'You can also add a bot/dialog (e.g. hh.ru notifications). Must be added to a category.',
      );
    }
    const topic = await getTopicByName(user.id, topicName);
    if (!topic) {
      return ctx.reply(`Category "${topicName}" not found. Create it first with /newtopic.`);
    }

    await ctx.reply('⏳ Resolving channel…');
    const result = await trackChannel(user, refPart, topic.id);
    if (!result.ok) return ctx.reply(result.error);
    const { source } = result.value;
    await ctx.reply(`✅ Tracking "${source.title ?? source.externalId}" in "${topicName}".`);
  });

  bot.command('remove', async (ctx) => {
    const user = await currentUser(ctx);
    const arg = commandArg(ctx);
    if (!arg) return ctx.reply('Usage: /remove <@username | id>');
    const source = await findSourceByRef(user.id, arg);
    if (!source) return ctx.reply('Channel not found. Use /channels to see the list.');
    await removeChannel(user.id, source.id);
    await ctx.reply(`🗑️ Removed "${source.title ?? source.externalId}".`);
  });

  bot.command('channels', async (ctx) => {
    const user = await currentUser(ctx);
    const sources = await listSources(user.id);
    if (sources.length === 0) return ctx.reply('No channels tracked yet. Add one with /add.');
    await ctx.reply(sources.map(formatSource).join('\n\n'), { parse_mode: 'HTML' });
  });

  bot.command('status', async (ctx) => {
    const user = await currentUser(ctx);
    const view = await statusView(user.id);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  // --- Category (topic) commands ---

  bot.command('topics', async (ctx) => {
    const user = await currentUser(ctx);
    const topics = await listTopics(user.id);
    if (topics.length === 0) return ctx.reply('No categories yet. Create one with /newtopic <name>.');
    await ctx.reply(topics.map((t) => `• ${t.name} — ${t.sourceCount} channel(s)`).join('\n'));
  });

  bot.command('newtopic', async (ctx) => {
    const user = await currentUser(ctx);
    const name = commandArg(ctx);
    if (!name) return ctx.reply('Usage: /newtopic <name>');
    const result = await makeTopic(user, name);
    if (!result.ok) return ctx.reply(result.error);
    await ctx.reply(`✅ Created category "${result.value.name}".`);
  });

  bot.command('renametopic', async (ctx) => {
    const user = await currentUser(ctx);
    const [oldName, newName] = splitPipe(commandArg(ctx));
    if (!oldName || !newName) return ctx.reply('Usage: /renametopic <name> | <new name>');
    const topic = await getTopicByName(user.id, oldName);
    if (!topic) return ctx.reply('Category not found.');
    const result = await renameTopicTo(user, topic.id, newName);
    if (!result.ok) return ctx.reply(result.error);
    await ctx.reply(`✅ Renamed to "${result.value}".`);
  });

  bot.command('deltopic', async (ctx) => {
    const user = await currentUser(ctx);
    const name = commandArg(ctx);
    if (!name) return ctx.reply('Usage: /deltopic <name>');
    const topic = await getTopicByName(user.id, name);
    if (!topic) return ctx.reply('Category not found.');
    await removeTopic(user.id, topic.id);
    await ctx.reply(`🗑️ Deleted category "${name}".`);
  });

  bot.command('addtotopic', async (ctx) => {
    const user = await currentUser(ctx);
    const [ref, topicName] = splitPipe(commandArg(ctx));
    if (!ref || !topicName) return ctx.reply('Usage: /addtotopic <channel> | <category>');
    const source = await findSourceByRef(user.id, ref);
    const topic = await getTopicByName(user.id, topicName);
    if (!source) return ctx.reply('Channel not found.');
    if (!topic) return ctx.reply('Category not found.');
    await addSourceToTopic(user.id, topic.id, source.id);
    await ctx.reply(`✅ Added "${source.title ?? source.externalId}" to "${topicName}".`);
  });

  bot.command('removefromtopic', async (ctx) => {
    const user = await currentUser(ctx);
    const [ref, topicName] = splitPipe(commandArg(ctx));
    if (!ref || !topicName) return ctx.reply('Usage: /removefromtopic <channel> | <category>');
    const source = await findSourceByRef(user.id, ref);
    const topic = await getTopicByName(user.id, topicName);
    if (!source || !topic) return ctx.reply('Channel or category not found.');
    await removeSourceFromTopic(user.id, topic.id, source.id);
    await ctx.reply('✅ Removed from category.');
  });

  // --- API token commands ---

  bot.command('token', async (ctx) => {
    const user = await currentUser(ctx);
    const name = commandArg(ctx) || null;
    const { token } = await createApiToken(user.id, name);
    await ctx.reply(
      `🔑 Your API token (shown once — store it safely):\n\n<code>${token}</code>\n\n` +
        `Use it as: Authorization: Bearer ${token.slice(0, 12)}…\nSee /apiinfo for details.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('tokens', async (ctx) => {
    const user = await currentUser(ctx);
    const tokens = await listApiTokens(user.id);
    if (tokens.length === 0) return ctx.reply('No API tokens. Create one with /token.');
    await ctx.reply(
      tokens
        .map((t) => `• ${t.id.slice(0, 8)} — ${t.name ?? 'unnamed'} (prefix ${t.prefix})`)
        .join('\n'),
    );
  });

  bot.command('revoketoken', async (ctx) => {
    const user = await currentUser(ctx);
    const idPart = commandArg(ctx);
    if (!idPart) return ctx.reply('Usage: /revoketoken <id>');
    const tokens = await listApiTokens(user.id);
    const target = tokens.find((t) => t.id.startsWith(idPart));
    if (!target) return ctx.reply('Token not found. Use /tokens to list them.');
    await revokeApiToken(user.id, target.id);
    await ctx.reply('🗑️ Token revoked.');
  });

  bot.command('apiinfo', async (ctx) => {
    const user = await currentUser(ctx);
    await ctx.reply(apiInfoText(user), { parse_mode: 'HTML' });
  });

  bot.command('whoami', async (ctx) => {
    const user = await currentUser(ctx);
    const session = await getSessionMeta(user.id);
    await ctx.reply(
      `User ID: ${user.id}\nTelegram ID: ${user.telegramUserId}\n` +
        `Account: ${session ? session.status : 'not connected'}`,
    );
  });

  // --- Reply-keyboard top-level navigation ---

  bot.hears('🗂 Categories', async (ctx) => {
    const user = await currentUser(ctx);
    clearPending(user.id);
    await sendView(ctx, await topicsView(user.id));
  });

  bot.hears('📰 Feed', async (ctx) => {
    const user = await currentUser(ctx);
    clearPending(user.id);
    await sendView(ctx, feedLinkView(feedUrl(user)));
  });

  bot.hears('👤 Account', async (ctx) => {
    const user = await currentUser(ctx);
    clearPending(user.id);
    await sendView(ctx, await accountView(user.id, loginUrl(user), feedUrl(user)));
  });

  bot.hears('⚙️ More', async (ctx) => {
    await currentUser(ctx);
    await ctx.reply(HELP);
  });

  // --- Inline button callbacks ---

  bot.on('callback_query:data', async (ctx) => {
    const user = await currentUser(ctx);
    const data = ctx.callbackQuery.data;
    try {
      await handleCallback(ctx, user, data, { loginUrl, feedUrl, apiInfoText });
    } catch (err) {
      log.error({ err, data }, 'callback handler error');
      await ctx.answerCallbackQuery({ text: 'Something went wrong.', show_alert: false });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
  });

  // --- Pending free-text input (add channel, new/rename category) ---

  bot.on('message:text', async (ctx) => {
    const user = await currentUser(ctx);
    const pending = getPending(user.id);
    if (!pending) {
      await ctx.reply('🤔 Use the menu buttons below, or /menu.', {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    clearPending(user.id);
    const input = ctx.message.text.trim();

    if (pending.kind === 'new_topic') {
      const result = await makeTopic(user, input);
      if (!result.ok) return ctx.reply(result.error);
      await ctx.reply(`✅ Created category "${result.value.name}".`);
      return sendView(ctx, await topicsView(user.id));
    }

    if (pending.kind === 'rename_topic') {
      const result = await renameTopicTo(user, pending.topicId, input);
      if (!result.ok) return ctx.reply(result.error);
      await ctx.reply(`✅ Renamed to "${result.value}".`);
      return sendView(ctx, await topicDetailView(user.id, { id: pending.topicId, name: result.value }));
    }

    // add_channel — always scoped to a category
    await ctx.reply('⏳ Resolving channel…');
    const result = await trackChannel(user, input, pending.topicId);
    if (!result.ok) return ctx.reply(result.error);
    const { source, note } = result.value;
    await ctx.reply(`✅ Tracking "${source.title ?? source.externalId}"${note}.`);
    const topic = pending.topicId ? await getTopic(user.id, pending.topicId) : null;
    if (topic) return sendView(ctx, await topicDetailView(user.id, topic));
    return sendView(ctx, await topicsView(user.id));
  });

  bot.catch((err) => log.error({ err: err.error }, 'bot handler error'));

  bot.api.setMyCommands(MENU_COMMANDS).catch((err) => log.error({ err }, 'setMyCommands failed'));
  return bot;
}

interface CallbackDeps {
  loginUrl: (user: User) => string;
  feedUrl: (user: User) => string;
  apiInfoText: (user: User) => string;
}

async function handleCallback(
  ctx: Context,
  user: User,
  data: string,
  deps: CallbackDeps,
): Promise<void> {
  const parts = data.split(':');
  const route = `${parts[0]}:${parts[1] ?? ''}`;

  switch (route) {
    case 'nav:menu':
      return editView(ctx, menuInlineView());

    // --- Channels (always within a category: ch:<op>:<s8>:<t8>) ---
    case 'ch:view': {
      const source = await findSourceByShortId(user.id, parts[2]!);
      const topic = await findTopicByShortId(user.id, parts[3]!);
      if (!source || !topic) return editView(ctx, await topicsView(user.id));
      return editView(ctx, await channelDetailView(source, topic));
    }
    case 'ch:rm': {
      const source = await findSourceByShortId(user.id, parts[2]!);
      const topic = await findTopicByShortId(user.id, parts[3]!);
      if (!source || !topic) return editView(ctx, await topicsView(user.id));
      return editView(
        ctx,
        confirmView(
          `🗑 Remove "${source.title ?? source.externalId}" from "${topic.name}"?\n` +
            `If it isn't in any other category, it will stop being tracked.`,
          `ch:rmyes:${parts[2]}:${parts[3]}`,
          `ch:view:${parts[2]}:${parts[3]}`,
        ),
      );
    }
    case 'ch:rmyes': {
      const source = await findSourceByShortId(user.id, parts[2]!);
      const topic = await findTopicByShortId(user.id, parts[3]!);
      if (source && topic) await removeChannelFromCategory(user.id, topic.id, source.id);
      if (topic) return editView(ctx, await topicDetailView(user.id, topic));
      return editView(ctx, await topicsView(user.id));
    }

    // --- Categories ---
    case 'tp:list':
      return editView(ctx, await topicsView(user.id));
    case 'tp:new':
      setPending(user.id, { kind: 'new_topic' });
      await ctx.reply('Send me a name for the new category — or /cancel.');
      return;
    case 'tp:view': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      if (!topic) return editView(ctx, await topicsView(user.id));
      return editView(ctx, await topicDetailView(user.id, topic));
    }
    case 'tp:addch': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      if (!topic) return editView(ctx, await topicsView(user.id));
      setPending(user.id, { kind: 'add_channel', topicId: topic.id });
      await ctx.reply(
        `Send me a channel @username, invite link, or a bot's @username (e.g. hh.ru notifications) to add to "${topic.name}" — or /cancel.`,
      );
      return;
    }
    case 'tp:manage': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      if (!topic) return editView(ctx, await topicsView(user.id));
      return editView(ctx, await manageChannelsView(user.id, topic));
    }
    case 'tp:tog': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      const source = await findSourceByShortId(user.id, parts[3]!);
      if (!topic || !source) return;
      const linked = await isChannelInTopic(user.id, topic.id, source.id);
      await toggleChannelInTopic(user.id, topic.id, source.id, linked);
      return editView(ctx, await manageChannelsView(user.id, topic));
    }
    case 'tp:rename': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      if (!topic) return editView(ctx, await topicsView(user.id));
      setPending(user.id, { kind: 'rename_topic', topicId: topic.id });
      await ctx.reply(`Send me a new name for "${topic.name}" — or /cancel.`);
      return;
    }
    case 'tp:del': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      if (!topic) return editView(ctx, await topicsView(user.id));
      return editView(
        ctx,
        confirmView(`🗑 Delete category "${topic.name}"?`, `tp:delyes:${parts[2]}`, `tp:view:${parts[2]}`),
      );
    }
    case 'tp:delyes': {
      const topic = await findTopicByShortId(user.id, parts[2]!);
      if (topic) await removeTopic(user.id, topic.id);
      return editView(ctx, await topicsView(user.id));
    }

    // --- Account ---
    case 'acct:home':
      return editView(ctx, await accountView(user.id, deps.loginUrl(user), deps.feedUrl(user)));
    case 'acct:status':
      return editView(ctx, await statusView(user.id));
    case 'acct:logout':
      await revokeSession(user.id);
      return editView(ctx, await accountView(user.id, deps.loginUrl(user), deps.feedUrl(user)));
    case 'acct:api':
      return editView(ctx, {
        text: deps.apiInfoText(user),
        reply_markup: new InlineKeyboard().text('⬅️ Back', 'acct:home'),
      });

    // --- More ---
    case 'more:home':
      return editView(ctx, {
        text: HELP,
        reply_markup: new InlineKeyboard().text('⬅️ Back', 'nav:menu'),
      });

    default:
      return;
  }
}

// Whether a channel currently belongs to a topic.
async function isChannelInTopic(userId: string, topicId: string, sourceId: string): Promise<boolean> {
  const ids = await getTopicIdsForSource(userId, sourceId);
  return ids.includes(topicId);
}

async function sendView(ctx: Context, view: View): Promise<void> {
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.reply_markup });
}

async function editView(ctx: Context, view: View): Promise<void> {
  try {
    await ctx.editMessageText(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.reply_markup,
    });
  } catch (err) {
    // "message is not modified" and stale-message edits are harmless.
    if (!/not modified|message to edit/i.test(String((err as any)?.description ?? err))) {
      throw err;
    }
  }
}

function commandArg(ctx: Context): string {
  const text = ctx.message?.text ?? '';
  const idx = text.indexOf(' ');
  return idx === -1 ? '' : text.slice(idx + 1).trim();
}

function splitPipe(arg: string): [string, string | undefined] {
  const parts = arg.split('|').map((s) => s.trim());
  return [parts[0] ?? '', parts[1] || undefined];
}

async function findSourceByRef(userId: string, ref: string) {
  const clean = ref.replace(/^@/, '').toLowerCase();
  const sources = await listSources(userId);
  return (
    sources.find(
      (s) =>
        s.id.startsWith(ref) ||
        s.externalId === ref ||
        (s.username ?? '').toLowerCase() === clean,
    ) ?? null
  );
}
