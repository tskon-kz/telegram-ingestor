import { describe, expect, it } from 'vitest';
import { clampLimit, decodeCursor, encodeCursor } from '../../src/storage/pagination.js';

describe('pagination', () => {
  it('encodes and decodes a cursor', () => {
    const c = encodeCursor({ seq: '42' });
    expect(decodeCursor<{ seq: string }>(c)).toEqual({ seq: '42' });
  });

  it('returns null for a malformed cursor', () => {
    expect(decodeCursor('!!!not-base64-json')).toBeNull();
  });

  it('clamps limits', () => {
    expect(clampLimit()).toBe(100);
    expect(clampLimit(0)).toBe(100);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(9999)).toBe(500);
  });
});
