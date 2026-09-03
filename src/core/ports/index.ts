import type { NormalizedMessage, Source, SourceType } from '../models/index.js';

// Extension point: new sources live under `sources/<name>/` implementing this.
export interface SourceConnector {
  readonly type: string;

  // Cursor is exclusive; returns messages ascending.
  fetchSince(source: Source, cursorMessageId: bigint | null): Promise<NormalizedMessage[]>;

  // Exclusive cursor to start a fresh source near `since`; null if no message is
  // that old (channel younger than the window). Used to bound backfill.
  seedCursor(source: Source, since: Date): Promise<bigint | null>;

  resolve(userId: string, ref: string): Promise<ResolvedSource>;
}

export interface ResolvedSource {
  sourceType: SourceType;
  externalId: string;
  title: string | null;
  username: string | null;
  isPrivate: boolean;
  joinStatus: 'joined' | 'accessible' | 'pending' | 'failed';
  telegramMeta: Record<string, unknown>;
}

export interface MessageBatchResult {
  inserted: number;
  skipped: number;
}
