import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging/index.js';
import { registerApiRoutes } from '../api/app.js';
import { registerLoginRoutes } from '../bot/loginRoutes.js';
import { createBot } from '../bot/index.js';
import { closePool } from '../db/pool.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger();

  const app = Fastify({ loggerInstance: log as any });
  // CSP disabled: the login page uses a small inline script; TLS is handled by Caddy.
  await app.register(helmet, { contentSecurityPolicy: false });
  await registerApiRoutes(app);
  await registerLoginRoutes(app);

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
