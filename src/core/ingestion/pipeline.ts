import type { NormalizedMessage, Source } from '../models/index.js';
import type { SourceConnector } from '../ports/index.js';

// Implemented by the storage layer, keeping this module free of DB/Telegram specifics.
export interface IngestionSink {
  insertMessages(
    ctx: { userId: string; sourceId: string },
    messages: NormalizedMessage[],
  ): Promise<{ inserted: number }>;
  updateCursor(sourceId: string, cursorMessageId: bigint): Promise<void>;
}

export interface IngestResult {
  fetched: number;
  inserted: number;
  newCursor: bigint | null;
}

// Idempotent: re-running from the same cursor is safe because inserts are conflict-skipped.
// Messages older than `cutoff` are skipped (outside the retention/partition window)
// but still advance the cursor, so backfill fast-forwards past ancient history.
export async function ingestSource(
  connector: SourceConnector,
  source: Source,
  sink: IngestionSink,
  cutoff: Date,
): Promise<IngestResult> {
  const messages = await connector.fetchSince(source, source.cursorMessageId);
  if (messages.length === 0) {
    return { fetched: 0, inserted: 0, newCursor: null };
  }

  const fresh = messages.filter((m) => m.publishedAt >= cutoff);
  let inserted = 0;
  if (fresh.length > 0) {
    ({ inserted } = await sink.insertMessages(
      { userId: source.userId, sourceId: source.id },
      fresh,
    ));
  }

  // Advance past the whole batch (incl. skipped-old rows) to make progress.
  const newCursor = messages.reduce<bigint>(
    (max, m) => (m.externalMessageId > max ? m.externalMessageId : max),
    source.cursorMessageId ?? 0n,
  );
  await sink.updateCursor(source.id, newCursor);

  return { fetched: messages.length, inserted, newCursor };
}
