import type { Api } from 'teleproto';
import type { NormalizedMessage } from '../../core/models/index.js';
import { sha256Hex } from '../../crypto/index.js';

// JSON-safe: converts bigint and Buffer so the raw payload can be stored as JSONB.
function safeJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object' && v.constructor?.name === 'Buffer') {
        return Buffer.from(v as Buffer).toString('base64');
      }
      return v;
    }),
  );
}

function extractLinks(msg: Api.Message): string[] {
  const links = new Set<string>();
  const text = msg.message ?? '';
  const entities = msg.entities ?? [];
  for (const e of entities) {
    if (e.className === 'MessageEntityTextUrl' && 'url' in e && e.url) {
      links.add(e.url);
    } else if (e.className === 'MessageEntityUrl') {
      links.add(text.substring(e.offset, e.offset + e.length));
    }
  }
  const media = msg.media as any;
  if (media?.className === 'MessageMediaWebPage' && media.webpage?.url) {
    links.add(media.webpage.url);
  }
  return [...links];
}

export function mapTelegramMessage(msg: Api.Message): NormalizedMessage {
  const text = msg.message ?? null;
  const media = msg.media as any;
  const metadata: Record<string, unknown> = {
    views: msg.views ?? null,
    forwards: msg.forwards ?? null,
    editDate: msg.editDate ? new Date(msg.editDate * 1000).toISOString() : null,
    groupedId: msg.groupedId ? msg.groupedId.toString() : null,
    hasMedia: !!msg.media,
    mediaType: media?.className ?? null,
    replyToMsgId: (msg.replyTo as any)?.replyToMsgId ?? null,
    postAuthor: msg.postAuthor ?? null,
    pinned: msg.pinned ?? false,
  };

  return {
    sourceType: 'telegram_channel',
    externalMessageId: BigInt(msg.id),
    publishedAt: new Date(msg.date * 1000),
    text,
    links: extractLinks(msg),
    metadata,
    rawPayload: safeJson(msg) as Record<string, unknown>,
    contentHash: sha256Hex(`${msg.id}:${text ?? ''}`),
  };
}
