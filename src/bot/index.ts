import { Bot, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import { loadConfig } from '../config/index.js';
import { childLogger } from '../logging/index.js';
import { signPayload } from '../crypto/index.js';
import { getQuotas, upsertUser } from '../storage/users.js';
import { revokeSession, getSessionMeta } from '../storage/sessions.js';
import {
  countSources,
  createSource,
  deleteSource,
  listSources,
} from '../storage/sources.js';
import {
  addSourceToTopic,
  countTopics,
  createTopic,
  deleteTopic,
  getTopicByName,
  listTopics,
  removeSourceFromTopic,
  renameTopic,
} from '../storage/topics.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../storage/tokens.js';
import { NotLoggedInError, withUserConnector } from '../sources/telegram/userSession.js';
import type { Source } from '../core/models/index.js';

const log = childLogger({ mod: 'bot' });
const LOGIN_TTL_MS = 10 * 60 * 1000;

const HELP = `Available commands:

/login – connect your Telegram account
/logout – disconnect your account

/add <@channel | invite-link> [ | topic] – track a channel
/remove <@username | id> – stop tracking a channel
/channels – list tracked channels + sync status
/status – sync status summary

/topics – list your topics
/newtopic <name> – create a topic
/renametopic <name> | <new name>
/deltopic <name>
/addtotopic <channel> | <topic>
/removefromtopic <channel> | <topic>

/token [name] – create an API token (shown once)
/tokens – list your API tokens
/revoketoken <id> – revoke a token
/apiinfo – how to access your data via the API/CLI
/whoami – your account info`;

async function currentUser(ctx: Context) {
  const from = ctx.from!;
  return upsertUser(BigInt(from.id), from.username ?? null);
}

export function createBot(): Bot {
  const cfg = loadConfig();
  const bot = new Bot(cfg.BOT_TOKEN);

  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (cfg.BOT_ALLOWLIST.length > 0 && !cfg.BOT_ALLOWLIST.includes(BigInt(ctx.from.id))) {
      await ctx.reply('⛔ You are not authorized to use this bot.');
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    await currentUser(ctx);
    await ctx.reply(`Welcome! This bot collects messages from your Telegram channels.\n\n${HELP}`);
  });
  bot.command('help', async (ctx) => ctx.reply(HELP));

  bot.command('login', async (ctx) => {
    const user = await currentUser(ctx);
    const token = signPayload(user.id, cfg.LOGIN_LINK_SECRET, LOGIN_TTL_MS);
    const url = `${cfg.PUBLIC_BASE_URL}/login?t=${encodeURIComponent(token)}`;
    await ctx.reply(
      'Open the secure login page to connect your Telegram account. ' +
        'Enter the code there (not here) — Telegram invalidates codes sent in chats.\n\n' +
        'This link is valid for 10 minutes.',
      { reply_markup: new InlineKeyboard().url('🔐 Open login page', url) },
    );
  });

  bot.command('logout', async (ctx) => {
    const user = await currentUser(ctx);
    await revokeSession(user.id);
    await ctx.reply('Disconnected. Your session was removed.');
  });

  bot.command('add', async (ctx) => {
    const user = await currentUser(ctx);
    const arg = commandArg(ctx);
    if (!arg) return ctx.reply('Usage: /add <@channel | invite-link> [ | topic]');
    const [refPart, topicName] = splitPipe(arg);
    if (!refPart) return ctx.reply('Usage: /add <@channel | invite-link> [ | topic]');

    const quotas = await getQuotas(user.id);
    if ((await countSources(user.id)) >= quotas.maxChannels) {
      return ctx.reply(`Channel limit reached (${quotas.maxChannels}).`);
    }

    await ctx.reply('Resolving channel…');
    let source: Source;
    try {
      const resolved = await withUserConnector(user.id, (c) => c.resolve(user.id, refPart));
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
      return ctx.reply(loginAwareError(err, 'Could not add channel'));
    }

    let note = '';
    if (topicName) {
      const topic = await getTopicByName(user.id, topicName);
      if (topic) {
        await addSourceToTopic(user.id, topic.id, source.id);
        note = ` (added to topic "${topicName}")`;
      } else {
        note = ` (topic "${topicName}" not found — create it with /newtopic)`;
      }
    }
    await ctx.reply(`✅ Tracking "${source.title ?? source.externalId}"${note}.`);
  });

  bot.command('remove', async (ctx) => {
    const user = await currentUser(ctx);
    const arg = commandArg(ctx);
    if (!arg) return ctx.reply('Usage: /remove <@username | id>');
    const source = await findSourceByRef(user.id, arg);
    if (!source) return ctx.reply('Channel not found. Use /channels to see the list.');
    await deleteSource(user.id, source.id);
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
    const session = await getSessionMeta(user.id);
    const sources = await listSources(user.id);
    const lines = [
      `Account: ${session ? session.status : 'not connected'}`,
      `Channels: ${sources.length}`,
      '',
      ...sources.map((s) => `• ${s.title ?? s.externalId} — ${s.syncStatus}${s.lastError ? ` (${s.lastError})` : ''}`),
    ];
    await ctx.reply(lines.join('\n'));
  });

  bot.command('topics', async (ctx) => {
    const user = await currentUser(ctx);
    const topics = await listTopics(user.id);
    if (topics.length === 0) return ctx.reply('No topics yet. Create one with /newtopic <name>.');
    await ctx.reply(topics.map((t) => `• ${t.name} — ${t.sourceCount} channel(s)`).join('\n'));
  });

  bot.command('newtopic', async (ctx) => {
    const user = await currentUser(ctx);
    const name = commandArg(ctx);
    if (!name) return ctx.reply('Usage: /newtopic <name>');
    const quotas = await getQuotas(user.id);
    if ((await countTopics(user.id)) >= quotas.maxTopics) {
      return ctx.reply(`Topic limit reached (${quotas.maxTopics}).`);
    }
    if (await getTopicByName(user.id, name)) return ctx.reply('A topic with that name already exists.');
    await createTopic(user.id, name);
    await ctx.reply(`✅ Created topic "${name}".`);
  });

  bot.command('renametopic', async (ctx) => {
    const user = await currentUser(ctx);
    const [oldName, newName] = splitPipe(commandArg(ctx));
    if (!oldName || !newName) return ctx.reply('Usage: /renametopic <name> | <new name>');
    const topic = await getTopicByName(user.id, oldName);
    if (!topic) return ctx.reply('Topic not found.');
    await renameTopic(user.id, topic.id, newName);
    await ctx.reply(`✅ Renamed to "${newName}".`);
  });

  bot.command('deltopic', async (ctx) => {
    const user = await currentUser(ctx);
    const name = commandArg(ctx);
    if (!name) return ctx.reply('Usage: /deltopic <name>');
    const topic = await getTopicByName(user.id, name);
    if (!topic) return ctx.reply('Topic not found.');
    await deleteTopic(user.id, topic.id);
    await ctx.reply(`🗑️ Deleted topic "${name}".`);
  });

  bot.command('addtotopic', async (ctx) => {
    const user = await currentUser(ctx);
    const [ref, topicName] = splitPipe(commandArg(ctx));
    if (!ref || !topicName) return ctx.reply('Usage: /addtotopic <channel> | <topic>');
    const source = await findSourceByRef(user.id, ref);
    const topic = await getTopicByName(user.id, topicName);
    if (!source) return ctx.reply('Channel not found.');
    if (!topic) return ctx.reply('Topic not found.');
    await addSourceToTopic(user.id, topic.id, source.id);
    await ctx.reply(`✅ Added "${source.title ?? source.externalId}" to "${topicName}".`);
  });

  bot.command('removefromtopic', async (ctx) => {
    const user = await currentUser(ctx);
    const [ref, topicName] = splitPipe(commandArg(ctx));
    if (!ref || !topicName) return ctx.reply('Usage: /removefromtopic <channel> | <topic>');
    const source = await findSourceByRef(user.id, ref);
    const topic = await getTopicByName(user.id, topicName);
    if (!source || !topic) return ctx.reply('Channel or topic not found.');
    await removeSourceFromTopic(user.id, topic.id, source.id);
    await ctx.reply('✅ Removed from topic.');
  });

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
    const base = cfg.PUBLIC_BASE_URL;
    await ctx.reply(
      `Your data is available via the read-only API (scoped to your account).\n\n` +
        `Base URL: ${base}\nUser ID: ${user.id}\n\n` +
        `1. Create a token: /token\n` +
        `2. Example:\n` +
        `curl -H "Authorization: Bearer <token>" "${base}/v1/messages?limit=50"\n\n` +
        `Endpoints: /v1/sources, /v1/topics, /v1/messages, /v1/messages/:id\n` +
        `CLI: INGEST_API_URL=${base} INGEST_TOKEN=<token> ingest-cli messages`,
    );
  });

  bot.command('whoami', async (ctx) => {
    const user = await currentUser(ctx);
    const session = await getSessionMeta(user.id);
    await ctx.reply(
      `User ID: ${user.id}\nTelegram ID: ${user.telegramUserId}\n` +
        `Account: ${session ? session.status : 'not connected'}`,
    );
  });

  bot.catch((err) => log.error({ err: err.error }, 'bot handler error'));
  return bot;
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

async function findSourceByRef(userId: string, ref: string): Promise<Source | null> {
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

function formatSource(s: Source): string {
  const handle = s.username ? `@${s.username}` : s.externalId;
  return (
    `<b>${escapeHtml(s.title ?? handle)}</b> (${s.id.slice(0, 8)})\n` +
    `${handle} · ${s.isPrivate ? 'private' : 'public'} · sync: ${s.syncStatus}` +
    (s.lastError ? `\n⚠️ ${escapeHtml(s.lastError)}` : '')
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loginAwareError(err: unknown, prefix: string): string {
  if (err instanceof NotLoggedInError) {
    return 'You need to connect your Telegram account first. Use /login.';
  }
  const msg = (err as any)?.errorMessage ?? (err as Error)?.message ?? String(err);
  return `${prefix}: ${msg}`;
}
