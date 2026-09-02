import pino, { type Logger } from 'pino';
import { loadConfig } from '../config/index.js';

let root: Logger | null = null;

export function getLogger(): Logger {
  if (root) return root;
  const cfg = loadConfig();
  const isDev = cfg.NODE_ENV === 'development';
  root = pino({
    level: cfg.LOG_LEVEL,
    redact: {
      paths: [
        'session',
        'encrypted_session',
        'token',
        'password',
        'apiHash',
        'botToken',
        '*.session',
        '*.token',
        '*.password',
      ],
      censor: '[redacted]',
    },
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  });
  return root;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
