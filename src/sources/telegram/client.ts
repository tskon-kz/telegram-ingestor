import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { loadConfig } from '../../config/index.js';

export function createTelegramClient(sessionString = ''): TelegramClient {
  const cfg = loadConfig();
  const client = new TelegramClient(
    new StringSession(sessionString),
    cfg.TELEGRAM_API_ID,
    cfg.TELEGRAM_API_HASH,
    {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      baseLogger: undefined,
    },
  );
  return client;
}

export function apiCredentials() {
  const cfg = loadConfig();
  return { apiId: cfg.TELEGRAM_API_ID, apiHash: cfg.TELEGRAM_API_HASH };
}
