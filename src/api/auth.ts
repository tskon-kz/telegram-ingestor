import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticateToken } from '../storage/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    await reply.code(401).send({ error: 'missing bearer token' });
    return;
  }
  const userId = await authenticateToken(match[1]!.trim());
  if (!userId) {
    await reply.code(401).send({ error: 'invalid token' });
    return;
  }
  req.userId = userId;
}
