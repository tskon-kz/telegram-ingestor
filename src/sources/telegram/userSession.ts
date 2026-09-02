import { createTelegramClient } from './client.js';
import { TelegramConnector } from './connector.js';
import { getSessionString } from '../../storage/sessions.js';

export class NotLoggedInError extends Error {
  constructor() {
    super('not logged in');
    this.name = 'NotLoggedInError';
  }
}

// Transient client from the user's stored session (for bot resolve/join); always disconnected.
export async function withUserConnector<T>(
  userId: string,
  fn: (connector: TelegramConnector) => Promise<T>,
): Promise<T> {
  const sessionString = await getSessionString(userId);
  if (!sessionString) throw new NotLoggedInError();
  const client = createTelegramClient(sessionString);
  await client.connect();
  try {
    return await fn(new TelegramConnector(client));
  } finally {
    await client.disconnect().catch(() => undefined);
    await client.destroy().catch(() => undefined);
  }
}
