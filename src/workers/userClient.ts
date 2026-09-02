import type { TelegramClient } from 'teleproto';
import { createTelegramClient } from '../sources/telegram/client.js';
import { TelegramConnector } from '../sources/telegram/connector.js';

export class UserClient {
  private client: TelegramClient | null = null;
  private connector: TelegramConnector | null = null;

  constructor(
    readonly userId: string,
    private readonly sessionString: string,
  ) {}

  async ensureConnected(): Promise<TelegramConnector> {
    if (!this.client) {
      this.client = createTelegramClient(this.sessionString);
    }
    if (!this.client.connected) {
      await this.client.connect();
    }
    if (!this.connector) {
      this.connector = new TelegramConnector(this.client);
    }
    return this.connector;
  }

  isAuthError(err: unknown): boolean {
    const msg = (err as any)?.errorMessage ?? '';
    return (
      typeof msg === 'string' &&
      (msg.includes('AUTH_KEY') || msg === 'SESSION_REVOKED' || msg === 'USER_DEACTIVATED')
    );
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect().catch(() => undefined);
    await this.client?.destroy().catch(() => undefined);
    this.client = null;
    this.connector = null;
  }
}
