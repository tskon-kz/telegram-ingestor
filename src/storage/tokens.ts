import { query } from '../db/pool.js';
import { generateApiToken, sha256Hex } from '../crypto/index.js';

export interface ApiTokenInfo {
  id: string;
  prefix: string;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

// Plaintext is returned once and never stored; only its hash is persisted.
export async function createApiToken(
  userId: string,
  name: string | null,
): Promise<{ token: string; info: ApiTokenInfo }> {
  const { token, prefix, hash } = generateApiToken();
  const res = await query(
    `INSERT INTO api_tokens (user_id, token_hash, prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, prefix, name, created_at, last_used_at`,
    [userId, hash, prefix, name],
  );
  const r = res.rows[0]!;
  return {
    token,
    info: {
      id: r.id,
      prefix: r.prefix,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    },
  };
}

export async function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const res = await query(
    `SELECT id, prefix, name, created_at, last_used_at
     FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    prefix: r.prefix,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const res = await query(
    `UPDATE api_tokens SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

// Resolves a plaintext token to its user id (and stamps last_used_at), or null.
export async function authenticateToken(token: string): Promise<string | null> {
  const hash = sha256Hex(token);
  const res = await query(
    `UPDATE api_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING user_id`,
    [hash],
  );
  return res.rows[0]?.user_id ?? null;
}
