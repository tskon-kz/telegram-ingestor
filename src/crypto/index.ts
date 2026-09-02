import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

// Layout: iv | authTag | ciphertext. keyHex is a 32-byte hex string.
export function encryptSecret(plaintext: string, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptSecret(payload: Buffer, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + 16);
  const enc = payload.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const token = `ingk_${prefix}_${secret}`;
  return { token, prefix, hash: sha256Hex(token) };
}

export function signPayload(payload: string, secret: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const body = `${payload}.${exp}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${sig}`;
}

export function verifySignedPayload(
  token: string,
  secret: string,
): { valid: boolean; payload?: string } {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [bodyB64, sig] = parts as [string, string];
  const body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return { valid: false };
  const sep = body.lastIndexOf('.');
  const payload = body.slice(0, sep);
  const exp = Number(body.slice(sep + 1));
  if (!Number.isFinite(exp) || Date.now() > exp) return { valid: false };
  return { valid: true, payload };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
