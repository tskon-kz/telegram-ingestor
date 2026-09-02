import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pingDb } from '../db/pool.js';
import { requireAuth } from './auth.js';
import { getSource, listSources } from '../storage/sources.js';
import { getTopic, getTopicSources, listTopics } from '../storage/topics.js';
import { getMessage, listMessages } from '../storage/messages.js';
import { serializeMessage, serializeSource, serializeTopic } from './serialize.js';

const messagesQuery = z.object({
  channel: z.string().uuid().optional(),
  source_id: z.string().uuid().optional(),
  topic: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  after_seq: z.string().regex(/^\d+$/).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_req, reply) => {
    const ok = await pingDb();
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'unavailable' });
  });

  app.register(async (v1) => {
    v1.addHook('preHandler', requireAuth);

    v1.get('/sources', async (req) => {
      const { topic } = (req.query as { topic?: string }) ?? {};
      const sources = await listSources(req.userId!, topic);
      return { data: sources.map(serializeSource) };
    });

    v1.get('/sources/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const source = await getSource(req.userId!, id);
      if (!source) return reply.code(404).send({ error: 'not found' });
      return serializeSource(source);
    });

    v1.get('/topics', async (req) => {
      const topics = await listTopics(req.userId!);
      return { data: topics.map(serializeTopic) };
    });

    v1.get('/topics/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const topic = await getTopic(req.userId!, id);
      if (!topic) return reply.code(404).send({ error: 'not found' });
      const sources = await getTopicSources(req.userId!, id);
      return { ...serializeTopic(topic), sources: sources.map(serializeSource) };
    });

    v1.get('/messages', async (req, reply) => {
      const parsed = messagesQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid query', details: parsed.error.issues });
      }
      const q = parsed.data;
      const page = await listMessages(req.userId!, {
        sourceId: q.source_id ?? q.channel,
        topicId: q.topic,
        from: q.from,
        to: q.to,
        afterSeq: q.after_seq,
        cursor: q.cursor,
        limit: q.limit,
      });
      return { data: page.data.map(serializeMessage), next_cursor: page.nextCursor };
    });

    v1.get('/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const message = await getMessage(req.userId!, id);
      if (!message) return reply.code(404).send({ error: 'not found' });
      return serializeMessage(message);
    });
  }, { prefix: '/v1' });
}
