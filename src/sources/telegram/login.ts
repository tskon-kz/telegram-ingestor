import { randomUUID } from 'node:crypto';
import { Api } from 'teleproto';
import { computeCheck } from 'teleproto/Password.js';
import { Raw } from 'teleproto/events/index.js';
import type { TelegramClient } from 'teleproto';
import QRCode from 'qrcode';
import { createTelegramClient, apiCredentials } from './client.js';
import { saveSession } from '../../storage/sessions.js';
import { childLogger } from '../../logging/index.js';

const log = childLogger({ mod: 'tg-login' });
const LOGIN_TTL_MS = 10 * 60 * 1000;
const QR_REFRESH_MARGIN_S = 5;

interface QrState {
  url: string;
  expires: number;
  svg: string;
  scanned: boolean;
}

interface LoginState {
  userId: string;
  phone?: string;
  phoneCodeHash?: string;
  qr?: QrState;
  client: TelegramClient;
  createdAt: number;
}

const sessions = new Map<string, LoginState>();

export type LoginStep = 'code_sent' | 'qr_pending' | 'password_needed' | 'done';

export type CodeDeliveryType =
  | 'app'
  | 'sms'
  | 'call'
  | 'flash_call'
  | 'missed_call'
  | 'email'
  | 'fragment'
  | 'unknown';

export interface CodeDelivery {
  type: CodeDeliveryType;
  length?: number;
  emailPattern?: string;
  fragmentUrl?: string;
  nextType?: CodeDeliveryType;
  timeout?: number;
}

export interface QrView {
  step: LoginStep;
  qr?: { url: string; svg: string; expires: number };
}

export class LoginUnavailableError extends Error {}

type LoginCompletedHandler = (userId: string) => Promise<void>;
let onLoginCompleted: LoginCompletedHandler | null = null;

export function setLoginCompletedHandler(handler: LoginCompletedHandler): void {
  onLoginCompleted = handler;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > LOGIN_TTL_MS) {
      s.client.disconnect().catch(() => undefined);
      sessions.delete(id);
    }
  }
}, 60_000).unref?.();

export async function startLogin(
  userId: string,
  phone: string,
): Promise<{ loginId: string; step: LoginStep; delivery: CodeDelivery }> {
  const client = createTelegramClient('');
  await client.connect();
  let sent: Api.auth.TypeSentCode;
  try {
    sent = await sendCodeRequest(client, phone);
  } catch (err) {
    await client.disconnect().catch(() => undefined);
    throw err;
  }
  const { phoneCodeHash, delivery } = parseSentCode(sent);
  const loginId = randomUUID();
  sessions.set(loginId, { userId, phone, phoneCodeHash, client, createdAt: Date.now() });
  log.info({ userId, delivery }, 'login started, code sent');
  return { loginId, step: 'code_sent', delivery };
}

export async function resendCode(loginId: string): Promise<CodeDelivery> {
  const s = mustGet(loginId);
  if (!s.phone || !s.phoneCodeHash) throw new Error('code login was not started');
  const sent = await s.client.invoke(
    new Api.auth.ResendCode({ phoneNumber: s.phone, phoneCodeHash: s.phoneCodeHash }),
  );
  const { phoneCodeHash, delivery } = parseSentCode(sent);
  s.phoneCodeHash = phoneCodeHash;
  log.info({ userId: s.userId, delivery }, 'login code resent');
  return delivery;
}

export async function submitCode(loginId: string, code: string): Promise<LoginStep> {
  const s = mustGet(loginId);
  if (!s.phone || !s.phoneCodeHash) throw new Error('code login was not started');
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

export async function startQrLogin(userId: string): Promise<{ loginId: string } & QrView> {
  const client = createTelegramClient('');
  await client.connect();
  const loginId = randomUUID();
  const s: LoginState = { userId, client, createdAt: Date.now() };
  try {
    s.qr = { ...(await exportQr(client)), scanned: false };
  } catch (err) {
    await client.disconnect().catch(() => undefined);
    throw err;
  }
  client.addEventHandler((update: unknown) => {
    if (update instanceof Api.UpdateLoginToken && s.qr) s.qr.scanned = true;
  }, new Raw({}));
  sessions.set(loginId, s);
  log.info({ userId }, 'qr login started');
  return { loginId, ...qrView(s.qr) };
}

export async function pollQrLogin(loginId: string): Promise<QrView> {
  const s = mustGet(loginId);
  if (!s.qr) throw new Error('qr login was not started');
  const nowS = Math.floor(Date.now() / 1000);
  // Re-exporting before the scan or expiry would replace the token the user may be scanning right now.
  if (!s.qr.scanned && s.qr.expires - QR_REFRESH_MARGIN_S > nowS) return qrView(s.qr);

  let result: Api.auth.TypeLoginToken;
  try {
    result = await s.client.invoke(
      new Api.auth.ExportLoginToken({ ...qrCredentials(), exceptIds: [] }),
    );
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await s.client._switchDC(result.dcId);
      result = await s.client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
    }
  } catch (err: any) {
    if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED') return { step: 'password_needed' };
    throw err;
  }

  if (result instanceof Api.auth.LoginTokenSuccess) {
    await finalize(loginId, s);
    return { step: 'done' };
  }
  if (result instanceof Api.auth.LoginToken) {
    s.qr = { ...(await renderQr(result)), scanned: false };
    return qrView(s.qr);
  }
  throw new Error(`unexpected qr login result: ${result.className}`);
}

export async function cancelLogin(loginId: string): Promise<void> {
  const s = sessions.get(loginId);
  if (!s) return;
  await s.client.disconnect().catch(() => undefined);
  sessions.delete(loginId);
}

async function sendCodeRequest(client: TelegramClient, phone: string): Promise<Api.auth.TypeSentCode> {
  const { apiId, apiHash } = apiCredentials();
  try {
    return await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );
  } catch (err: any) {
    if (err?.errorMessage === 'AUTH_RESTART') return sendCodeRequest(client, phone);
    throw err;
  }
}

function parseSentCode(sent: Api.auth.TypeSentCode): { phoneCodeHash: string; delivery: CodeDelivery } {
  if (sent instanceof Api.auth.SentCodePaymentRequired) {
    throw new LoginUnavailableError(
      'Telegram requires a paid verification for this number. Use QR login instead.',
    );
  }
  if (!(sent instanceof Api.auth.SentCode)) {
    throw new LoginUnavailableError(`Unexpected Telegram response: ${sent.className}. Use QR login instead.`);
  }
  const t = sent.type;
  if (t instanceof Api.auth.SentCodeTypeSetUpEmailRequired) {
    throw new LoginUnavailableError(
      'Telegram requires setting up a login email for this number. Use QR login instead.',
    );
  }
  const delivery: CodeDelivery = {
    type: sentCodeType(t),
    nextType: sent.nextType ? nextCodeType(sent.nextType) : undefined,
    timeout: sent.timeout,
  };
  if ('length' in t) delivery.length = t.length;
  if (t instanceof Api.auth.SentCodeTypeEmailCode) delivery.emailPattern = t.emailPattern;
  if (t instanceof Api.auth.SentCodeTypeFragmentSms) delivery.fragmentUrl = t.url;
  return { phoneCodeHash: sent.phoneCodeHash, delivery };
}

function sentCodeType(t: Api.auth.TypeSentCodeType): CodeDeliveryType {
  if (t instanceof Api.auth.SentCodeTypeApp) return 'app';
  if (t instanceof Api.auth.SentCodeTypeEmailCode) return 'email';
  if (t instanceof Api.auth.SentCodeTypeFragmentSms) return 'fragment';
  if (t instanceof Api.auth.SentCodeTypeCall) return 'call';
  if (t instanceof Api.auth.SentCodeTypeFlashCall) return 'flash_call';
  if (t instanceof Api.auth.SentCodeTypeMissedCall) return 'missed_call';
  if (
    t instanceof Api.auth.SentCodeTypeSms ||
    t instanceof Api.auth.SentCodeTypeSmsWord ||
    t instanceof Api.auth.SentCodeTypeSmsPhrase ||
    t instanceof Api.auth.SentCodeTypeFirebaseSms
  ) {
    return 'sms';
  }
  return 'unknown';
}

function nextCodeType(t: Api.auth.TypeCodeType): CodeDeliveryType {
  if (t instanceof Api.auth.CodeTypeSms) return 'sms';
  if (t instanceof Api.auth.CodeTypeCall) return 'call';
  if (t instanceof Api.auth.CodeTypeFlashCall) return 'flash_call';
  if (t instanceof Api.auth.CodeTypeMissedCall) return 'missed_call';
  if (t instanceof Api.auth.CodeTypeFragmentSms) return 'fragment';
  return 'unknown';
}

function qrCredentials() {
  const { apiId, apiHash } = apiCredentials();
  return { apiId: Number(apiId), apiHash };
}

async function exportQr(client: TelegramClient): Promise<Omit<QrState, 'scanned'>> {
  const result = await client.invoke(new Api.auth.ExportLoginToken({ ...qrCredentials(), exceptIds: [] }));
  if (!(result instanceof Api.auth.LoginToken)) {
    throw new Error(`unexpected qr login result: ${result.className}`);
  }
  return renderQr(result);
}

async function renderQr(token: Api.auth.LoginToken): Promise<Omit<QrState, 'scanned'>> {
  const url = `tg://login?token=${Buffer.from(token.token).toString('base64url')}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
  return { url, svg, expires: token.expires };
}

function qrView(qr: QrState): QrView {
  return { step: 'qr_pending', qr: { url: qr.url, svg: qr.svg, expires: qr.expires } };
}

async function finalize(loginId: string, s: LoginState): Promise<void> {
  const sessionString = String(s.client.session.save());
  let tgAccountId: bigint | null = null;
  let phone = s.phone;
  try {
    const me = (await s.client.getMe()) as Api.User;
    tgAccountId = me?.id ? BigInt(me.id.toString()) : null;
    phone ??= me?.phone ? `+${me.phone}` : undefined;
  } catch {
    // Non-fatal: session is still valid without the account id.
  }
  await saveSession(s.userId, sessionString, { phone: phone ?? null, tgAccountId });
  await s.client.disconnect().catch(() => undefined);
  sessions.delete(loginId);
  log.info({ userId: s.userId }, 'login finalized, session stored');
  onLoginCompleted?.(s.userId).catch((err) =>
    log.warn({ userId: s.userId, err }, 'login completed notification failed'),
  );
}

function mustGet(loginId: string): LoginState {
  const s = sessions.get(loginId);
  if (!s) throw new Error('login session not found or expired');
  return s;
}
