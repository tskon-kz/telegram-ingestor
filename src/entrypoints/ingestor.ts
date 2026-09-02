import http from 'node:http';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging/index.js';
import { createIngestor } from '../workers/ingestor.js';
import { startMaintenanceScheduler } from '../maintenance/index.js';
import { pingDb, closePool } from '../db/pool.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = getLogger();

  const ingestor = createIngestor();
  ingestor.start();
  const stopMaintenance = startMaintenanceScheduler();

  const health = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.url === '/ready') {
      void pingDb().then((ok) => res.writeHead(ok ? 200 : 503).end(ok ? 'ready' : 'down'));
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(cfg.HTTP_PORT, cfg.HTTP_HOST);
  log.info({ port: cfg.HTTP_PORT, workerId: cfg.WORKER_ID }, 'ingestor health server listening');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down ingestor');
    stopMaintenance();
    await ingestor.stop().catch(() => undefined);
    health.close();
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  getLogger().fatal({ err }, 'ingestor failed to start');
  process.exit(1);
});
