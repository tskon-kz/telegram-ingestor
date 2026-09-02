import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  sha256Hex,
  signPayload,
  verifySignedPayload,
} from '../../src/crypto/index.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('crypto', () => {
  it('encrypts and decrypts round-trip', () => {
    const secret = 'my-telegram-session-string';
    const enc = encryptSecret(secret, KEY);
    expect(enc).toBeInstanceOf(Buffer);
    expect(enc.toString('utf8')).not.toContain(secret);
    expect(decryptSecret(enc, KEY)).toBe(secret);
  });

  it('fails to decrypt with a different key', () => {
    const enc = encryptSecret('x', KEY);
    expect(() => decryptSecret(enc, 'b'.repeat(64))).toThrow();
  });

  it('generates a token whose hash matches sha256', () => {
    const { token, hash } = generateApiToken();
    expect(hash).toBe(sha256Hex(token));
    expect(token.startsWith('ingk_')).toBe(true);
  });

  it('signs and verifies a payload', () => {
    const token = signPayload('user-123', 'secret-secret-secret', 10_000);
    const res = verifySignedPayload(token, 'secret-secret-secret');
    expect(res.valid).toBe(true);
    expect(res.payload).toBe('user-123');
  });

  it('rejects an expired payload', () => {
    const token = signPayload('user-123', 'secret-secret-secret', -1);
    expect(verifySignedPayload(token, 'secret-secret-secret').valid).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = signPayload('user-123', 'secret-secret-secret', 10_000);
    expect(verifySignedPayload(token + 'x', 'secret-secret-secret').valid).toBe(false);
    expect(verifySignedPayload(token, 'wrong-secret-secret').valid).toBe(false);
  });
});
