import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../config/index.js';
import { signPayload, verifySignedPayload } from '../crypto/index.js';

export const PORTAL_COOKIE = 'portal_session';

// Short-lived token embedded in the bot link; exchanged once for a session cookie.
const PORTAL_LINK_TTL_MS = 10 * 60 * 1000;
// Session cookie lifetime once the link is exchanged.
const PORTAL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Signed link the bot hands out; the portal swaps `t` for a session cookie.
export function portalUrl(userId: string): string {
  const { PUBLIC_BASE_URL, LOGIN_LINK_SECRET } = loadConfig();
  const token = signPayload(userId, LOGIN_LINK_SECRET, PORTAL_LINK_TTL_MS);
  return `${PUBLIC_BASE_URL}/app?t=${encodeURIComponent(token)}`;
}

// Verify the short-lived link token, returning the userId it was issued for.
export function verifyPortalLink(token: string): string | null {
  const { LOGIN_LINK_SECRET } = loadConfig();
  const res = verifySignedPayload(token, LOGIN_LINK_SECRET);
  return res.valid ? res.payload ?? null : null;
}

export function setPortalCookie(reply: FastifyReply, userId: string): void {
  const { LOGIN_LINK_SECRET } = loadConfig();
  const session = signPayload(userId, LOGIN_LINK_SECRET, PORTAL_SESSION_TTL_MS);
  reply.setCookie(PORTAL_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true, // TLS terminates at Caddy
    path: '/',
    maxAge: Math.floor(PORTAL_SESSION_TTL_MS / 1000),
  });
}

export function clearPortalCookie(reply: FastifyReply): void {
  reply.clearCookie(PORTAL_COOKIE, { path: '/' });
}

// Read and verify the session cookie, returning the userId or null.
export function readPortalSession(req: FastifyRequest): string | null {
  const raw = req.cookies?.[PORTAL_COOKIE];
  if (!raw) return null;
  const { LOGIN_LINK_SECRET } = loadConfig();
  const res = verifySignedPayload(raw, LOGIN_LINK_SECRET);
  return res.valid ? res.payload ?? null : null;
}
