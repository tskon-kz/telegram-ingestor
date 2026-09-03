import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging/index.js';
import { registerApiRoutes } from '../api/app.js';
import { registerLoginRoutes } from '../bot/loginRoutes.js';
import { registerPortalRoutes } from '../api/portalRoutes.js';
import { createBot } from '../bot/index.js';
import { closePool } from '../db/pool.js';

// Built client assets (Vite). Resolved from cwd (project root in dev, /app in Docker).
const PORTAL_DIR = resolve(process.env.PORTAL_STATIC_DIR ?? 'client/dist');

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger();

  const app = Fastify({ loggerInstance: log as any });
  // CSP disabled: the login page uses a small inline script; TLS is handled by Caddy.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await registerApiRoutes(app);
  await registerLoginRoutes(app);
  await registerPortalRoutes(app);

  // Serve the SPA under /app; unknown /app/* paths fall back to index.html
  // so client-side routing (e.g. /app/login) works on hard refresh. Skipped in
  // dev when the client hasn't been built (Vite serves it on its own port).
  if (existsSync(PORTAL_DIR)) {
    await app.register(fastifyStatic, { root: PORTAL_DIR, prefix: '/app/', wildcard: false });
    app.get('/app', (_req, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/app/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    log.warn({ dir: PORTAL_DIR }, 'client build not found; portal SPA not served');
  }

  const bot = createBot();
  // Bot polling runs alongside the HTTP server; a bot failure (bad token,
  // Telegram outage) must not take down the API/login endpoints.
  bot
    .start({ onStart: () => log.info('bot started (long polling)') })
    .catch((err) => log.error({ err }, 'bot polling stopped'));

  await app.listen({ host: cfg.HTTP_HOST, port: cfg.HTTP_PORT });
  log.info({ port: cfg.HTTP_PORT }, 'http server listening');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down app');
    await bot.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  getLogger().fatal({ err }, 'app failed to start');
  process.exit(1);
});
