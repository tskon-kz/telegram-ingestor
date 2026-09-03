import { Api, type TelegramClient } from 'teleproto';
import type { NormalizedMessage, Source } from '../../core/models/index.js';
import type { ResolvedSource, SourceConnector } from '../../core/ports/index.js';
import { mapTelegramMessage } from './mapper.js';

const FETCH_LIMIT = 200;

interface ChannelMeta {
  peerType: 'channel';
  channelId: string;
  accessHash: string;
}

interface UserMeta {
  peerType: 'user';
  userId: string;
  accessHash: string;
}

// Legacy sources were stored before peerType existed; treat them as channels.
type PeerMeta = ChannelMeta | UserMeta;

// Bound to one user's authenticated MTProto client.
export class TelegramConnector implements SourceConnector {
  readonly type = 'telegram_channel';

  constructor(private readonly client: TelegramClient) {}

  async fetchSince(source: Source, cursorMessageId: bigint | null): Promise<NormalizedMessage[]> {
    const peer = this.peer(source);
    const messages = await this.client.getMessages(peer, {
      minId: cursorMessageId != null ? Number(cursorMessageId) : 0,
      reverse: true, // ascending, exclusive of minId
      limit: FETCH_LIMIT,
    });
    return messages
      .filter((m): m is Api.Message => m instanceof Api.Message)
      // In dialogs both sides post; skip our own outgoing replies.
      .filter((m) => !m.out)
      .map((m) => mapTelegramMessage(m, source.type));
  }

  async seedCursor(source: Source, since: Date): Promise<bigint | null> {
    const peer = this.peer(source);
    // offsetDate returns messages at/older than the date (descending); the first
    // one is the newest message before the window. Use it as an exclusive cursor.
    const messages = await this.client.getMessages(peer, {
      offsetDate: Math.floor(since.getTime() / 1000),
      limit: 1,
    });
    const first = messages.find((m): m is Api.Message => m instanceof Api.Message);
    return first ? BigInt(first.id) : null;
  }

  async resolve(_userId: string, ref: string): Promise<ResolvedSource> {
    const invite = parseInviteHash(ref);
    if (invite) return this.resolveInvite(invite);
    return this.resolveUsername(normalizeUsername(ref));
  }

  private async resolveUsername(username: string): Promise<ResolvedSource> {
    const entity = await this.client.getEntity(username);
    if (entity instanceof Api.Channel) {
      // Public channel: read history without joining, so it doesn't clutter the
      // account's chat list. access_hash from getEntity is enough for getMessages.
      return this.toResolvedChannel(entity, false, 'accessible');
    }
    if (entity instanceof Api.User) {
      // Bot or user DM (e.g. hh.ru notifications). We already have the dialog,
      // so history is readable directly via the user peer.
      return this.toResolvedUser(entity);
    }
    throw new Error('reference is not a channel or user');
  }

  private async resolveInvite(hash: string): Promise<ResolvedSource> {
    let channel: Api.Channel | null = null;
    try {
      const res = await this.client.invoke(new Api.messages.ImportChatInvite({ hash }));
      if (res instanceof Api.messages.ChatInviteJoinResultOk) {
        channel = extractChannel(res.updates);
      }
    } catch (err: any) {
      if (err?.errorMessage === 'USER_ALREADY_PARTICIPANT') {
        const info = await this.client.invoke(new Api.messages.CheckChatInvite({ hash }));
        if (info instanceof Api.ChatInviteAlready && info.chat instanceof Api.Channel) {
          channel = info.chat;
        }
      } else {
        throw err;
      }
    }
    if (!channel) throw new Error('could not resolve private invite');
    return this.toResolvedChannel(channel, true, 'joined');
  }

  private toResolvedChannel(
    channel: Api.Channel,
    isPrivate: boolean,
    joinStatus: 'joined' | 'accessible',
  ): ResolvedSource {
    const meta: ChannelMeta = {
      peerType: 'channel',
      channelId: channel.id.toString(),
      accessHash: channel.accessHash?.toString() ?? '0',
    };
    return {
      sourceType: 'telegram_channel',
      externalId: channel.id.toString(),
      title: channel.title ?? null,
      username: channel.username ?? null,
      isPrivate,
      joinStatus,
      telegramMeta: meta as unknown as Record<string, unknown>,
    };
  }

  private toResolvedUser(user: Api.User): ResolvedSource {
    const meta: UserMeta = {
      peerType: 'user',
      userId: user.id.toString(),
      accessHash: user.accessHash?.toString() ?? '0',
    };
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
    return {
      sourceType: 'telegram_dialog',
      externalId: user.id.toString(),
      title: name,
      username: user.username ?? null,
      isPrivate: true,
      joinStatus: 'accessible',
      telegramMeta: meta as unknown as Record<string, unknown>,
    };
  }

  private peer(source: Source): Api.TypeInputPeer {
    const meta = source.telegramMeta as unknown as PeerMeta;
    if (meta?.peerType === 'user') {
      if (!meta.userId) {
        throw new Error(`source ${source.id} missing telegram peer metadata`);
      }
      return new Api.InputPeerUser({
        userId: BigInt(meta.userId) as any,
        accessHash: BigInt(meta.accessHash ?? '0') as any,
      });
    }
    const channelMeta = meta as unknown as ChannelMeta;
    if (!channelMeta?.channelId) {
      throw new Error(`source ${source.id} missing telegram peer metadata`);
    }
    return new Api.InputPeerChannel({
      channelId: BigInt(channelMeta.channelId) as any,
      accessHash: BigInt(channelMeta.accessHash ?? '0') as any,
    });
  }
}

function normalizeUsername(ref: string): string {
  let u = ref.trim();
  u = u.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '');
  u = u.replace(/^@/, '');
  return u;
}

function parseInviteHash(ref: string): string | null {
  const m = ref.trim().match(/(?:joinchat\/|t\.me\/\+|telegram\.me\/\+)([\w-]+)/i);
  if (m) return m[1] ?? null;
  const plus = ref.trim().match(/^\+([\w-]+)$/);
  return plus ? plus[1] ?? null : null;
}

function extractChannel(updates: Api.TypeUpdates): Api.Channel | null {
  const chats = (updates as any).chats as Api.TypeChat[] | undefined;
  if (!chats) return null;
  for (const c of chats) {
    if (c instanceof Api.Channel) return c;
  }
  return null;
}
