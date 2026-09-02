#!/usr/bin/env node
import { Command } from 'commander';

interface GlobalOpts {
  baseUrl?: string;
  token?: string;
}

function resolveConfig(opts: GlobalOpts): { baseUrl: string; token: string } {
  const baseUrl = opts.baseUrl || process.env.INGEST_API_URL || '';
  const token = opts.token || process.env.INGEST_TOKEN || '';
  if (!baseUrl) throw new Error('Missing API base URL (set INGEST_API_URL or --base-url)');
  if (!token) throw new Error('Missing token (set INGEST_TOKEN or --token)');
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

async function apiGet<T>(cfg: { baseUrl: string; token: string }, path: string): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function buildQuery(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

const program = new Command();
program
  .name('ingest-cli')
  .description('Read-only client for the Telegram Ingestor API')
  .option('--base-url <url>', 'API base URL (or INGEST_API_URL)')
  .option('--token <token>', 'API token (or INGEST_TOKEN)');

program
  .command('sources')
  .description('List tracked sources')
  .option('--topic <id>', 'filter by topic id')
  .action(async (opts) => {
    const cfg = resolveConfig(program.opts());
    print(await apiGet(cfg, `/v1/sources${buildQuery({ topic: opts.topic })}`));
  });

program
  .command('topics')
  .description('List topics')
  .action(async () => {
    const cfg = resolveConfig(program.opts());
    print(await apiGet(cfg, '/v1/topics'));
  });

program
  .command('messages')
  .description('List messages')
  .option('--channel <sourceId>', 'filter by source id')
  .option('--topic <topicId>', 'filter by topic id')
  .option('--from <iso>', 'published_at >= from')
  .option('--to <iso>', 'published_at < to')
  .option('--after-seq <seq>', 'messages ingested after this ingest_seq')
  .option('--limit <n>', 'page size')
  .option('--cursor <cursor>', 'pagination cursor')
  .option('--all', 'follow pagination and stream all as NDJSON')
  .action(async (opts) => {
    const cfg = resolveConfig(program.opts());
    const base = buildQuery({
      channel: opts.channel,
      topic: opts.topic,
      from: opts.from,
      to: opts.to,
      after_seq: opts.afterSeq,
      limit: opts.limit,
    });

    if (!opts.all) {
      const q = opts.cursor
        ? `${base}${base ? '&' : '?'}cursor=${encodeURIComponent(opts.cursor)}`
        : base;
      print(await apiGet(cfg, `/v1/messages${q}`));
      return;
    }

    let cursor: string | null = opts.cursor ?? null;
    do {
      const q = cursor
        ? `${base}${base ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
        : base;
      const page = await apiGet<{ data: unknown[]; next_cursor: string | null }>(
        cfg,
        `/v1/messages${q}`,
      );
      for (const row of page.data) process.stdout.write(`${JSON.stringify(row)}\n`);
      cursor = page.next_cursor;
    } while (cursor);
  });

program
  .command('get <id>')
  .description('Get a single message by id')
  .action(async (id: string) => {
    const cfg = resolveConfig(program.opts());
    print(await apiGet(cfg, `/v1/messages/${encodeURIComponent(id)}`));
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
