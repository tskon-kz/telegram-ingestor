import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import migrationRunner from 'node-pg-migrate';

// Modules imported dynamically AFTER env is configured (config caches on load).
type Mods = {
  users: typeof import('../../src/storage/users.js');
  sources: typeof import('../../src/storage/sources.js');
  topics: typeof import('../../src/storage/topics.js');
  messages: typeof import('../../src/storage/messages.js');
  tokens: typeof import('../../src/storage/tokens.js');
  sessions: typeof import('../../src/storage/sessions.js');
  pool: typeof import('../../src/db/pool.js');
  maintenance: typeof import('../../src/maintenance/index.js');
};

let container: StartedPostgreSqlContainer;
let m: Mods;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();

  process.env.DATABASE_URL = url;
  process.env.PUBLIC_BASE_URL = 'https://x.example.com';
  process.env.POSTGRES_PASSWORD = 'x';
  process.env.TELEGRAM_API_ID = '1';
  process.env.TELEGRAM_API_HASH = 'x';
  process.env.BOT_TOKEN = 'x';
  process.env.MASTER_KEY = 'a'.repeat(64);
  process.env.LOGIN_LINK_SECRET = '0123456789abcdef';

  await migrationRunner({
    databaseUrl: url,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => undefined,
  });

  m = {
    users: await import('../../src/storage/users.js'),
    sources: await import('../../src/storage/sources.js'),
    topics: await import('../../src/storage/topics.js'),
    messages: await import('../../src/storage/messages.js'),
    tokens: await import('../../src/storage/tokens.js'),
    sessions: await import('../../src/storage/sessions.js'),
    pool: await import('../../src/db/pool.js'),
    maintenance: await import('../../src/maintenance/index.js'),
  };
}, 120_000);

afterAll(async () => {
  await m?.pool.closePool();
  await container?.stop();
});

function normMsg(id: number, publishedAt: Date) {
  return {
    sourceType: 'telegram_channel' as const,
    externalMessageId: BigInt(id),
    publishedAt,
    text: `message ${id}`,
    links: [`https://t.me/x/${id}`],
    metadata: { views: id },
    rawPayload: { id },
    contentHash: null,
  };
}

describe('storage integration', () => {
  it('deduplicates messages on re-insert', async () => {
    const user = await m.users.upsertUser(1001n, 'alice');
    const src = await m.sources.createSource({
      userId: user.id,
      type: 'telegram_channel',
      externalId: '5001',
      title: 'Chan',
      username: 'chan',
      isPrivate: false,
      joinStatus: 'joined',
      telegramMeta: { channelId: '5001', accessHash: '1' },
    });
    const now = new Date('2026-08-15T00:00:00Z');
    const batch = [normMsg(1, now), normMsg(2, now), normMsg(3, now)];

    const first = await m.messages.insertMessages({ userId: user.id, sourceId: src.id }, batch);
    expect(first.inserted).toBe(3);
    // Re-insert overlapping batch: only the new one counts.
    const second = await m.messages.insertMessages(
      { userId: user.id, sourceId: src.id },
      [...batch, normMsg(4, now)],
    );
    expect(second.inserted).toBe(1);
  });

  it('isolates one user from another user data', async () => {
    const alice = await m.users.upsertUser(2001n, 'alice2');
    const bob = await m.users.upsertUser(2002n, 'bob');
    const aliceSrc = await m.sources.createSource({
      userId: alice.id,
      type: 'telegram_channel',
      externalId: '6001',
      title: 'A',
      username: null,
      isPrivate: false,
      joinStatus: 'joined',
      telegramMeta: { channelId: '6001', accessHash: '1' },
    });
    const now = new Date('2026-08-16T00:00:00Z');
    await m.messages.insertMessages({ userId: alice.id, sourceId: aliceSrc.id }, [normMsg(10, now)]);

    const bobView = await m.messages.listMessages(bob.id, {});
    expect(bobView.data).toHaveLength(0);
    const aliceView = await m.messages.listMessages(alice.id, {});
    expect(aliceView.data.length).toBeGreaterThan(0);
    // Bob cannot fetch Alice's message by id.
    const msgId = aliceView.data[0]!.id;
    expect(await m.messages.getMessage(bob.id, msgId)).toBeNull();
  });

  it('paginates messages with a keyset cursor', async () => {
    const user = await m.users.upsertUser(3001n, 'carol');
    const src = await m.sources.createSource({
      userId: user.id,
      type: 'telegram_channel',
      externalId: '7001',
      title: 'C',
      username: null,
      isPrivate: false,
      joinStatus: 'joined',
      telegramMeta: { channelId: '7001', accessHash: '1' },
    });
    const base = new Date('2026-08-17T00:00:00Z').getTime();
    const batch = Array.from({ length: 5 }, (_, i) =>
      normMsg(100 + i, new Date(base + i * 1000)),
    );
    await m.messages.insertMessages({ userId: user.id, sourceId: src.id }, batch);

    const page1 = await m.messages.listMessages(user.id, { sourceId: src.id, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await m.messages.listMessages(user.id, {
      sourceId: src.id,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.data).toHaveLength(2);
    const ids1 = page1.data.map((x) => x.id);
    const ids2 = page2.data.map((x) => x.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('filters incrementally with after_seq', async () => {
    const user = await m.users.upsertUser(4001n, 'dave');
    const src = await m.sources.createSource({
      userId: user.id,
      type: 'telegram_channel',
      externalId: '8001',
      title: 'D',
      username: null,
      isPrivate: false,
      joinStatus: 'joined',
      telegramMeta: { channelId: '8001', accessHash: '1' },
    });
    const now = new Date('2026-08-18T00:00:00Z');
    await m.messages.insertMessages({ userId: user.id, sourceId: src.id }, [
      normMsg(200, now),
      normMsg(201, now),
    ]);
    const all = await m.messages.listMessages(user.id, { sourceId: src.id });
    const midSeq = all.data[0]!.ingestSeq;
    const after = await m.messages.listMessages(user.id, { sourceId: src.id, afterSeq: midSeq });
    expect(after.data.every((x) => BigInt(x.ingestSeq) > BigInt(midSeq))).toBe(true);
  });

  it('encrypts and round-trips a stored session', async () => {
    const user = await m.users.upsertUser(5001n, 'erin');
    await m.sessions.saveSession(user.id, 'SESSION-STRING-XYZ', { phone: '+100', tgAccountId: 42n });
    const raw = await m.pool.query('SELECT encrypted_session FROM telegram_sessions WHERE user_id=$1', [user.id]);
    expect(Buffer.from(raw.rows[0]!.encrypted_session).toString('utf8')).not.toContain('SESSION-STRING-XYZ');
    expect(await m.sessions.getSessionString(user.id)).toBe('SESSION-STRING-XYZ');
  });

  it('authenticates API tokens and enforces revocation', async () => {
    const user = await m.users.upsertUser(6001n, 'frank');
    const { token } = await m.tokens.createApiToken(user.id, 'ci');
    expect(await m.tokens.authenticateToken(token)).toBe(user.id);
    const list = await m.tokens.listApiTokens(user.id);
    await m.tokens.revokeApiToken(user.id, list[0]!.id);
    expect(await m.tokens.authenticateToken(token)).toBeNull();
  });

  it('claims sessions with a lease for exactly one worker', async () => {
    const user = await m.users.upsertUser(7001n, 'grace');
    await m.sessions.saveSession(user.id, 'S', {});
    const w1 = await m.sessions.claimSessions('worker-1', 60, 10);
    expect(w1).toContain(user.id);
    // A second worker cannot claim it while the lease is valid.
    const w2 = await m.sessions.claimSessions('worker-2', 60, 10);
    expect(w2).not.toContain(user.id);
  });

  it('drops partitions older than the retention window', async () => {
    // Create an old partition and confirm maintenance drops it.
    await m.pool.query(`SELECT ensure_messages_partition('2000-01-01'::date)`);
    const before = await m.pool.query(
      `SELECT 1 FROM pg_class WHERE relname = 'messages_2000_01'`,
    );
    expect(before.rowCount).toBe(1);
    const dropped = await m.maintenance.dropOldPartitions(90);
    expect(dropped).toContain('messages_2000_01');
    const after = await m.pool.query(
      `SELECT 1 FROM pg_class WHERE relname = 'messages_2000_01'`,
    );
    expect(after.rowCount).toBe(0);
  });
});
