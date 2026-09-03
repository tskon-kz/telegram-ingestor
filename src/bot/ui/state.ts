// In-memory pending-input state. The app runs a single long-polling bot
// instance, and this state is short-lived and non-critical, so a Map is fine.

export type Pending =
  | { kind: 'add_channel'; topicId?: string }
  | { kind: 'new_topic' }
  | { kind: 'rename_topic'; topicId: string };

const pending = new Map<string, Pending>();

export function getPending(userId: string): Pending | undefined {
  return pending.get(userId);
}

export function setPending(userId: string, state: Pending): void {
  pending.set(userId, state);
}

export function clearPending(userId: string): void {
  pending.delete(userId);
}
