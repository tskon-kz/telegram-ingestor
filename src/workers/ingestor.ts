import { loadConfig } from '../config/index.js';
import { childLogger } from '../logging/index.js';
import { ingestSource } from '../core/ingestion/pipeline.js';
import { insertMessages } from '../storage/messages.js';
import {
  getSyncableSources,
  markSyncStatus,
  updateCursor,
} from '../storage/sources.js';
import {
  claimSessions,
  getSessionString,
  markSessionStatus,
  releaseLeases,
  renewLeases,
} from '../storage/sessions.js';
import { UserClient } from './userClient.js';

const log = childLogger({ mod: 'ingestor' });

const POLL_INTERVAL_MS = 15_000;
const LEASE_SECONDS = 60;
const MAX_USERS_PER_WORKER = 200;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sink = { insertMessages, updateCursor };

export class Ingestor {
  private readonly clients = new Map<string, UserClient>();
  private readonly failures = new Map<string, number>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly workerId: string) {}

  start(): void {
    this.running = true;
    log.info({ workerId: this.workerId }, 'ingestor started');
    void this.loop();
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.loop(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      // A tick-level failure (e.g. Postgres blip) must not stop the worker.
      log.error({ err }, 'ingestor tick failed');
    } finally {
      this.schedule();
    }
  }

  private async tick(): Promise<void> {
    const owned = await claimSessions(this.workerId, LEASE_SECONDS, MAX_USERS_PER_WORKER);
    const ownedSet = new Set(owned);
    await renewLeases(this.workerId, owned, LEASE_SECONDS);

    for (const userId of [...this.clients.keys()]) {
      if (!ownedSet.has(userId)) {
        await this.clients.get(userId)?.disconnect();
        this.clients.delete(userId);
      }
    }

    for (const userId of owned) {
      await this.syncUser(userId).catch((err) =>
        log.error({ err, userId }, 'user sync failed'),
      );
    }
  }

  private async syncUser(userId: string): Promise<void> {
    const uc = await this.getClient(userId);
    if (!uc) return;

    let connector;
    try {
      connector = await uc.ensureConnected();
    } catch (err) {
      if (uc.isAuthError(err)) {
        log.warn({ userId }, 'session invalid, marking needs_reauth');
        await markSessionStatus(userId, 'needs_reauth');
        await uc.disconnect();
        this.clients.delete(userId);
        return;
      }
      throw err; // transient (e.g. Telegram down) -> retry next tick
    }

    const cutoff = new Date(Date.now() - loadConfig().RETENTION_DAYS * DAY_MS);
    const sources = await getSyncableSources(userId);
    for (const source of sources) {
      if (source.backoffUntil && source.backoffUntil.getTime() > Date.now()) continue;
      try {
        await markSyncStatus(source.id, 'syncing');
        // Fresh source: start near the retention cutoff so backfill stays inside
        // the partition window instead of crawling from the channel's origin.
        if (source.cursorMessageId == null) {
          const seed = await connector.seedCursor(source, cutoff);
          if (seed != null) {
            await updateCursor(source.id, seed);
            source.cursorMessageId = seed;
          }
        }
        const result = await ingestSource(connector, source, sink, cutoff);
        if (result.inserted > 0) {
          log.info(
            { userId, sourceId: source.id, fetched: result.fetched, inserted: result.inserted },
            'ingested messages',
          );
        }
        await markSyncStatus(source.id, 'idle');
        this.failures.delete(source.id);
      } catch (err) {
        await this.handleSourceError(source.id, err);
      }
    }
  }

  private async handleSourceError(sourceId: string, err: unknown): Promise<void> {
    const n = (this.failures.get(sourceId) ?? 0) + 1;
    this.failures.set(sourceId, n);
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS);
    const backoffUntil = new Date(Date.now() + backoff);
    const message = (err as any)?.errorMessage ?? (err as Error)?.message ?? String(err);
    log.warn({ sourceId, err: message, backoffMs: backoff }, 'source ingest error, backing off');
    await markSyncStatus(sourceId, 'error', {
      lastError: String(message).slice(0, 500),
      backoffUntil,
    });
  }

  private async getClient(userId: string): Promise<UserClient | null> {
    const existing = this.clients.get(userId);
    if (existing) return existing;
    const sessionString = await getSessionString(userId);
    if (!sessionString) return null;
    const uc = new UserClient(userId, sessionString);
    this.clients.set(userId, uc);
    return uc;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    for (const uc of this.clients.values()) {
      await uc.disconnect();
    }
    this.clients.clear();
    await releaseLeases(this.workerId).catch(() => undefined);
    log.info({ workerId: this.workerId }, 'ingestor stopped');
  }
}

export function createIngestor(): Ingestor {
  return new Ingestor(loadConfig().WORKER_ID);
}
