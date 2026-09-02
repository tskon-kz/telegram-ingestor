import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

loadDotenv();

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes hex (64 hex chars)');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url(),

  POSTGRES_HOST: z.string().default('postgres'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().default('telegram_ingestor'),
  POSTGRES_USER: z.string().default('ingestor'),
  POSTGRES_PASSWORD: z.string(),
  DATABASE_URL: z.string().optional(),

  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(1),

  BOT_TOKEN: z.string().min(1),
  BOT_ALLOWLIST: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => BigInt(s)),
    ),

  MASTER_KEY: hex32,
  LOGIN_LINK_SECRET: z.string().min(16),

  WORKER_ID: z
    .string()
    .default('')
    .transform((v) => v.trim() || `worker-${randomUUID().slice(0, 8)}`),
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
});

export type AppConfig = z.infer<typeof schema> & { databaseUrl: string };

function buildDatabaseUrl(c: z.infer<typeof schema>): string {
  if (c.DATABASE_URL) return c.DATABASE_URL;
  const auth = `${encodeURIComponent(c.POSTGRES_USER)}:${encodeURIComponent(c.POSTGRES_PASSWORD)}`;
  return `postgres://${auth}@${c.POSTGRES_HOST}:${c.POSTGRES_PORT}/${c.POSTGRES_DB}`;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = { ...parsed.data, databaseUrl: buildDatabaseUrl(parsed.data) };
  return cached;
}
