import { query } from '../db/pool.js';
import { loadConfig } from '../config/index.js';
import { childLogger } from '../logging/index.js';

const log = childLogger({ mod: 'maintenance' });
const DAY_MS = 24 * 60 * 60 * 1000;

export async function ensurePartitions(): Promise<void> {
  await query(
    `SELECT ensure_messages_partition(
       (date_trunc('month', now()) + (g || ' month')::interval)::date)
     FROM generate_series(-4, 2) AS g`,
  );
}

function partitionName(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `messages_${y}_${m}`;
}

// Partition names sort lexically in chronological order, so name comparison is safe.
export async function dropOldPartitions(retentionDays: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const keepStart = partitionName(cutoff); // keep the month containing the cutoff

  const res = await query<{ relname: string }>(
    `SELECT c.relname
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'messages'`,
  );

  const toDrop = res.rows
    .map((r) => r.relname)
    .filter((name) => /^messages_\d{4}_\d{2}$/.test(name) && name < keepStart);

  for (const name of toDrop) {
    await query(`DROP TABLE IF EXISTS ${name}`);
    log.info({ partition: name }, 'dropped old partition');
  }
  return toDrop;
}

export async function runMaintenance(): Promise<void> {
  const cfg = loadConfig();
  await ensurePartitions();
  await dropOldPartitions(cfg.RETENTION_DAYS);
}

export function startMaintenanceScheduler(): () => void {
  void runMaintenance().catch((err) => log.error({ err }, 'initial maintenance failed'));
  const timer = setInterval(() => {
    void runMaintenance().catch((err) => log.error({ err }, 'scheduled maintenance failed'));
  }, DAY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
