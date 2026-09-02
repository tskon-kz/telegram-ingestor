import { Api, type TelegramClient } from 'teleproto';
import type { NormalizedMessage, Source } from '../../core/models/index.js';
import type { ResolvedSource, SourceConnector } from '../../core/ports/index.js';
import { mapTelegramMessage } from './mapper.js';

const FETCH_LIMIT = 200;

interface ChannelMeta {
  channelId: string;
  accessHash: string;
}

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
      .map(mapTelegramMessage);
  }

  async resolve(_userId: string, ref: string): Promise<ResolvedSource> {
    const invite = parseInviteHash(ref);
    if (invite) return this.resolveInvite(invite);
    return this.resolveUsername(normalizeUsername(ref));
  }

  private async resolveUsername(username: string): Promise<ResolvedSource> {
    const entity = await this.client.getEntity(username);
    if (!(entity instanceof Api.Channel)) {
      throw new Error('reference is not a channel');
    }
    // Public channel: join so live updates are delivered.
    await this.client
      .invoke(new Api.channels.JoinChannel({ channel: entity }))
      .catch(() => undefined);
    return this.toResolved(entity, false);
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
    return this.toResolved(channel, true);
  }

  private toResolved(channel: Api.Channel, isPrivate: boolean): ResolvedSource {
    const meta: ChannelMeta = {
      channelId: channel.id.toString(),
      accessHash: channel.accessHash?.toString() ?? '0',
    };
    return {
      externalId: channel.id.toString(),
      title: channel.title ?? null,
      username: channel.username ?? null,
      isPrivate,
      joinStatus: 'joined',
      telegramMeta: meta as unknown as Record<string, unknown>,
    };
  }

  private peer(source: Source): Api.InputPeerChannel {
    const meta = source.telegramMeta as unknown as ChannelMeta;
    if (!meta?.channelId) {
      throw new Error(`source ${source.id} missing telegram peer metadata`);
    }
    return new Api.InputPeerChannel({
      channelId: BigInt(meta.channelId) as any,
      accessHash: BigInt(meta.accessHash ?? '0') as any,
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
