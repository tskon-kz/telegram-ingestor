import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listMessages } from '../storage/messages.js';
import { listSources } from '../storage/sources.js';
import { listTopics } from '../storage/topics.js';
import { serializeMessage, serializeSource, serializeTopic } from './serialize.js';
import {
  clearPortalCookie,
  readPortalSession,
  setPortalCookie,
  verifyPortalLink,
} from '../bot/portalSession.js';

const messagesQuery = z.object({
  channel: z.string().uuid().optional(),
  topic: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

async function requirePortalSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = readPortalSession(req);
  if (!userId) {
    await reply.code(401).send({ error: 'not authenticated' });
    return;
  }
  req.userId = userId;
}

export async function registerPortalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/portal/api/session', async (req, reply) => {
    const body = z.object({ t: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid input' });
    const userId = verifyPortalLink(body.data.t);
    if (!userId) return reply.code(401).send({ error: 'invalid or expired link' });
    setPortalCookie(reply, userId);
    return { ok: true };
  });

  app.post('/portal/api/logout', async (_req, reply) => {
    clearPortalCookie(reply);
    return { ok: true };
  });

  app.register(async (p) => {
    p.addHook('preHandler', requirePortalSession);

    p.get('/topics', async (req) => {
      const topics = await listTopics(req.userId!);
      return { data: topics.map(serializeTopic) };
    });

    p.get('/sources', async (req) => {
      const sources = await listSources(req.userId!);
      return { data: sources.map(serializeSource) };
    });

    p.get('/messages', async (req, reply) => {
      const parsed = messagesQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid query', details: parsed.error.issues });
      }
      const q = parsed.data;
      const page = await listMessages(req.userId!, {
        sourceId: q.channel,
        topicId: q.topic,
        cursor: q.cursor,
        limit: q.limit,
      });
      return { data: page.data.map(serializeMessage), next_cursor: page.nextCursor };
    });
  }, { prefix: '/portal/api' });
}
