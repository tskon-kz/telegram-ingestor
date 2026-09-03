export interface Topic {
  id: string;
  name: string;
  source_count?: number;
  created_at: string;
}

export interface Source {
  id: string;
  type: string;
  external_id: string;
  title: string | null;
  username: string | null;
  is_private: boolean;
  sync_status: string;
}

export interface Message {
  id: string;
  source_id: string;
  external_message_id: string;
  published_at: string;
  text: string | null;
  links: string[];
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function exchangeToken(t: string): Promise<void> {
  await json(
    await fetch('/portal/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t }),
    }),
  );
}

export async function fetchTopics(): Promise<Topic[]> {
  const r = await json<{ data: Topic[] }>(await fetch('/portal/api/topics', { credentials: 'include' }));
  return r.data;
}

export async function fetchSources(): Promise<Source[]> {
  const r = await json<{ data: Source[] }>(await fetch('/portal/api/sources', { credentials: 'include' }));
  return r.data;
}

export async function fetchMessages(params: {
  topic?: string;
  channel?: string;
  cursor?: string;
  limit?: number;
}): Promise<Page<Message>> {
  const qs = new URLSearchParams();
  if (params.topic) qs.set('topic', params.topic);
  if (params.channel) qs.set('channel', params.channel);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  return json<Page<Message>>(
    await fetch(`/portal/api/messages?${qs.toString()}`, { credentials: 'include' }),
  );
}

// --- Telegram login (reuses the existing /login/api/* endpoints) ---

export type LoginStep = 'code_sent' | 'password_needed' | 'done';

async function loginPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (j as { error?: string }).error ?? 'error');
  return j as T;
}

export function loginStart(t: string, phone: string) {
  return loginPost<{ loginId: string; step: LoginStep }>('/login/api/start', { t, phone });
}
export function loginCode(t: string, loginId: string, code: string) {
  return loginPost<{ step: LoginStep }>('/login/api/code', { t, loginId, code });
}
export function loginPassword(t: string, loginId: string, password: string) {
  return loginPost<{ step: LoginStep }>('/login/api/password', { t, loginId, password });
}
