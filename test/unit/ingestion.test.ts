import { describe, expect, it } from 'vitest';
import { ingestSource, type IngestionSink } from '../../src/core/ingestion/pipeline.js';
import type { NormalizedMessage, Source } from '../../src/core/models/index.js';
import type { ResolvedSource, SourceConnector } from '../../src/core/ports/index.js';

const CUTOFF = new Date('2020-01-01T00:00:00Z');

function msg(id: number, publishedAt = new Date('2026-01-01T00:00:00Z')): NormalizedMessage {
  return {
    sourceType: 'telegram_channel',
    externalMessageId: BigInt(id),
    publishedAt,
    text: `m${id}`,
    links: [],
    metadata: {},
    rawPayload: {},
    contentHash: null,
  };
}

const source: Source = {
  id: 'src-1',
  userId: 'user-1',
  type: 'telegram_channel',
  externalId: '100',
  title: null,
  username: null,
  isPrivate: false,
  joinStatus: 'joined',
  cursorMessageId: null,
  syncStatus: 'idle',
  lastSyncedAt: null,
  lastError: null,
  backoffUntil: null,
  telegramMeta: {},
  addedAt: new Date(),
};

class FakeConnector implements SourceConnector {
  readonly type = 'telegram_channel';
  constructor(private readonly messages: NormalizedMessage[]) {}
  async fetchSince(_s: Source, cursor: bigint | null): Promise<NormalizedMessage[]> {
    const c = cursor ?? 0n;
    return this.messages.filter((m) => m.externalMessageId > c);
  }
  async seedCursor(): Promise<bigint | null> {
    return null;
  }
  async resolve(): Promise<ResolvedSource> {
    throw new Error('not used');
  }
}

function fakeSink(store: Set<string>): IngestionSink {
  return {
    async insertMessages(_ctx, messages) {
      let inserted = 0;
      for (const m of messages) {
        const key = m.externalMessageId.toString();
        if (!store.has(key)) {
          store.add(key);
          inserted++;
        }
      }
      return { inserted };
    },
    async updateCursor() {
      /* no-op */
    },
  };
}

describe('ingestSource', () => {
  it('inserts messages and advances the cursor', async () => {
    const connector = new FakeConnector([msg(1), msg(2), msg(3)]);
    const store = new Set<string>();
    const res = await ingestSource(connector, source, fakeSink(store), CUTOFF);
    expect(res.fetched).toBe(3);
    expect(res.inserted).toBe(3);
    expect(res.newCursor).toBe(3n);
  });

  it('is idempotent on re-run past the cursor', async () => {
    const connector = new FakeConnector([msg(1), msg(2)]);
    const store = new Set<string>();
    await ingestSource(connector, source, fakeSink(store), CUTOFF);
    // Re-run with an already-advanced cursor: nothing new fetched.
    const res = await ingestSource(
      connector,
      { ...source, cursorMessageId: 2n },
      fakeSink(store),
      CUTOFF,
    );
    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
  });

  it('skips pre-cutoff messages but still advances the cursor past them', async () => {
    const old = new Date('2019-06-01T00:00:00Z'); // before CUTOFF
    const recent = new Date('2026-01-01T00:00:00Z'); // after CUTOFF
    const connector = new FakeConnector([msg(1, old), msg(2, old), msg(3, recent)]);
    const store = new Set<string>();
    const res = await ingestSource(connector, source, fakeSink(store), CUTOFF);
    expect(res.fetched).toBe(3);
    expect(res.inserted).toBe(1); // only msg(3)
    expect(res.newCursor).toBe(3n); // cursor advances past the skipped old rows
    expect(store.has('3')).toBe(true);
    expect(store.has('1')).toBe(false);
  });
});
