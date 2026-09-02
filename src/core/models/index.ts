// Source-agnostic domain models: no Telegram-specific fields leak here.

export type UserStatus = 'active' | 'blocked';

export interface User {
  id: string;
  telegramUserId: bigint;
  username: string | null;
  status: UserStatus;
  plan: string;
  createdAt: Date;
}

export interface UserQuotas {
  userId: string;
  maxChannels: number;
  maxTopics: number;
}

export type SourceType = 'telegram_channel';
export type JoinStatus = 'pending' | 'joined' | 'failed' | 'left';
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'paused';

export interface Source {
  id: string;
  userId: string;
  type: SourceType;
  externalId: string;
  title: string | null;
  username: string | null;
  isPrivate: boolean;
  joinStatus: JoinStatus;
  cursorMessageId: bigint | null;
  syncStatus: SyncStatus;
  lastSyncedAt: Date | null;
  lastError: string | null;
  backoffUntil: Date | null;
  telegramMeta: Record<string, unknown>;
  addedAt: Date;
}

export interface Topic {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  userId: string;
  sourceId: string;
  sourceType: SourceType;
  externalMessageId: bigint;
  publishedAt: Date;
  fetchedAt: Date;
  ingestSeq: string; // bigint serialized as string for JSON safety
  text: string | null;
  links: string[];
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  contentHash: string | null;
}

export interface NormalizedMessage {
  sourceType: SourceType;
  externalMessageId: bigint;
  publishedAt: Date;
  text: string | null;
  links: string[];
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  contentHash: string | null;
}
