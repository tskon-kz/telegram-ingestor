import type { NormalizedMessage, Source } from '../models/index.js';

// Extension point: new sources live under `sources/<name>/` implementing this.
export interface SourceConnector {
  readonly type: string;

  // Cursor is exclusive; returns messages ascending.
  fetchSince(source: Source, cursorMessageId: bigint | null): Promise<NormalizedMessage[]>;

  resolve(userId: string, ref: string): Promise<ResolvedSource>;
}

export interface ResolvedSource {
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
