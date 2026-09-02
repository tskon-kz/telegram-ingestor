import { randomUUID } from 'node:crypto';
import { Api } from 'teleproto';
import { computeCheck } from 'teleproto/Password.js';
import type { TelegramClient } from 'teleproto';
import { createTelegramClient, apiCredentials } from './client.js';
import { saveSession } from '../../storage/sessions.js';
import { childLogger } from '../../logging/index.js';

const log = childLogger({ mod: 'tg-login' });
const LOGIN_TTL_MS = 10 * 60 * 1000;

interface LoginState {
  userId: string;
  phone: string;
  phoneCodeHash: string;
  client: TelegramClient;
  createdAt: number;
}

const sessions = new Map<string, LoginState>();

export type LoginStep = 'code_sent' | 'password_needed' | 'done';

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > LOGIN_TTL_MS) {
      s.client.disconnect().catch(() => undefined);
      sessions.delete(id);
    }
  }
}, 60_000).unref?.();

export async function startLogin(userId: string, phone: string): Promise<{ loginId: string; step: LoginStep }> {
  const client = createTelegramClient('');
  await client.connect();
  const { phoneCodeHash } = await client.sendCode(apiCredentials(), phone);
  const loginId = randomUUID();
  sessions.set(loginId, { userId, phone, phoneCodeHash, client, createdAt: Date.now() });
  log.info({ userId }, 'login started, code sent');
  return { loginId, step: 'code_sent' };
}

export async function submitCode(loginId: string, code: string): Promise<LoginStep> {
  const s = mustGet(loginId);
  try {
    await s.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: s.phone,
        phoneCodeHash: s.phoneCodeHash,
        phoneCode: code,
      }),
    );
  } catch (err: any) {
    if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return 'password_needed';
    }
    throw err;
  }
  await finalize(loginId, s);
  return 'done';
}

export async function submitPassword(loginId: string, password: string): Promise<LoginStep> {
  const s = mustGet(loginId);
  const pwd = await s.client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(pwd, password);
  await s.client.invoke(new Api.auth.CheckPassword({ password: check }));
  await finalize(loginId, s);
  return 'done';
}

export async function cancelLogin(loginId: string): Promise<void> {
  const s = sessions.get(loginId);
  if (!s) return;
  await s.client.disconnect().catch(() => undefined);
  sessions.delete(loginId);
}

async function finalize(loginId: string, s: LoginState): Promise<void> {
  const sessionString = String(s.client.session.save());
  let tgAccountId: bigint | null = null;
  try {
    const me = (await s.client.getMe()) as Api.User;
    tgAccountId = me?.id ? BigInt(me.id.toString()) : null;
  } catch {
    // Non-fatal: session is still valid without the account id.
  }
  await saveSession(s.userId, sessionString, { phone: s.phone, tgAccountId });
  await s.client.disconnect().catch(() => undefined);
  sessions.delete(loginId);
  log.info({ userId: s.userId }, 'login finalized, session stored');
}

function mustGet(loginId: string): LoginState {
  const s = sessions.get(loginId);
  if (!s) throw new Error('login session not found or expired');
  return s;
}
