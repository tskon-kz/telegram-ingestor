import { query, withTransaction } from '../db/pool.js';
import type { User, UserQuotas } from '../core/models/index.js';
import { mapQuotas, mapUser } from './rows.js';

export async function findUserByTelegramId(telegramUserId: bigint): Promise<User | null> {
  const res = await query('SELECT * FROM users WHERE telegram_user_id = $1', [
    telegramUserId.toString(),
  ]);
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

export async function upsertUser(
  telegramUserId: bigint,
  username: string | null,
): Promise<User> {
  return withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO users (telegram_user_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_user_id)
         DO UPDATE SET username = EXCLUDED.username
       RETURNING *`,
      [telegramUserId.toString(), username],
    );
    const user = mapUser(res.rows[0]);
    await client.query(
      `INSERT INTO user_quotas (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [user.id],
    );
    return user;
  });
}

export async function getQuotas(userId: string): Promise<UserQuotas> {
  const res = await query('SELECT * FROM user_quotas WHERE user_id = $1', [userId]);
  if (res.rows[0]) return mapQuotas(res.rows[0]);
  return { userId, maxChannels: 20, maxTopics: 20 };
}
