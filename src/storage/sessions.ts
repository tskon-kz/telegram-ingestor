import { query } from '../db/pool.js';
import { loadConfig } from '../config/index.js';
import { decryptSecret, encryptSecret } from '../crypto/index.js';

export type SessionStatus = 'active' | 'needs_reauth' | 'revoked';

export interface SessionMeta {
  userId: string;
  phone: string | null;
  tgAccountId: bigint | null;
  status: SessionStatus;
}

export async function saveSession(
  userId: string,
  sessionString: string,
  meta: { phone?: string | null; tgAccountId?: bigint | null } = {},
): Promise<void> {
  const { MASTER_KEY } = loadConfig();
  const encrypted = encryptSecret(sessionString, MASTER_KEY);
  await query(
    `INSERT INTO telegram_sessions
       (user_id, encrypted_session, phone, tg_account_id, status, last_authorized_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       encrypted_session = EXCLUDED.encrypted_session,
       phone = EXCLUDED.phone,
       tg_account_id = EXCLUDED.tg_account_id,
       status = 'active',
       last_authorized_at = now(),
       updated_at = now()`,
    [
      userId,
      encrypted,
      meta.phone ?? null,
      meta.tgAccountId != null ? meta.tgAccountId.toString() : null,
    ],
  );
}

export async function getSessionString(userId: string): Promise<string | null> {
  const { MASTER_KEY } = loadConfig();
  const res = await query(
    `SELECT encrypted_session FROM telegram_sessions
     WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  if (!res.rows[0]) return null;
  return decryptSecret(res.rows[0].encrypted_session, MASTER_KEY);
}

export async function getSessionMeta(userId: string): Promise<SessionMeta | null> {
  const res = await query(
    `SELECT user_id, phone, tg_account_id, status
     FROM telegram_sessions WHERE user_id = $1`,
    [userId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    userId: r.user_id,
    phone: r.phone,
    tgAccountId: r.tg_account_id == null ? null : BigInt(r.tg_account_id),
    status: r.status,
  };
}

export async function markSessionStatus(
  userId: string,
  status: SessionStatus,
): Promise<void> {
  await query(
    `UPDATE telegram_sessions SET status = $2, updated_at = now() WHERE user_id = $1`,
    [userId, status],
  );
}

export async function revokeSession(userId: string): Promise<void> {
  await query(`DELETE FROM telegram_sessions WHERE user_id = $1`, [userId]);
}

// Claim active sessions via a time-based lease: claimable if unowned, ours, or lease expired.
export async function claimSessions(
  workerId: string,
  leaseSeconds: number,
  limit: number,
): Promise<string[]> {
  const res = await query(
    `UPDATE telegram_sessions s
     SET owner_worker_id = $1, lease_expires_at = now() + ($2 || ' seconds')::interval
     WHERE s.user_id IN (
       SELECT user_id FROM telegram_sessions
       WHERE status = 'active'
         AND (owner_worker_id IS NULL
              OR owner_worker_id = $1
              OR lease_expires_at IS NULL
              OR lease_expires_at < now())
       ORDER BY lease_expires_at NULLS FIRST
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING s.user_id`,
    [workerId, leaseSeconds, limit],
  );
  return res.rows.map((r) => r.user_id);
}

export async function renewLeases(
  workerId: string,
  userIds: string[],
  leaseSeconds: number,
): Promise<void> {
  if (userIds.length === 0) return;
  await query(
    `UPDATE telegram_sessions
     SET lease_expires_at = now() + ($2 || ' seconds')::interval
     WHERE owner_worker_id = $1 AND user_id = ANY($3::uuid[])`,
    [workerId, leaseSeconds, userIds],
  );
}

export async function releaseLeases(workerId: string): Promise<void> {
  await query(
    `UPDATE telegram_sessions
     SET owner_worker_id = NULL, lease_expires_at = NULL
     WHERE owner_worker_id = $1`,
    [workerId],
  );
}
