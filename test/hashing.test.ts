import { describe, test, expect } from 'vitest';
import { chunkHashOf, entryHashOf, combineEntryHashes, chunkBlobKey } from '../src/hashing.js';
import { encodeValue } from '../src/serialization.js';

describe('chunkHashOf', () => {
  test('returns a 64-char hex string', () => {
    const hash = chunkHashOf(new Uint8Array([1, 2, 3]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same input → same hash', () => {
    const a = chunkHashOf(new Uint8Array([10, 20, 30]));
    const b = chunkHashOf(new Uint8Array([10, 20, 30]));
    expect(a).toBe(b);
  });

  test('different input → different hash', () => {
    const a = chunkHashOf(new Uint8Array([1]));
    const b = chunkHashOf(new Uint8Array([2]));
    expect(a).not.toBe(b);
  });
});

describe('entryHashOf', () => {
  test('empty entries → all-zero 32-byte buffer', () => {
    const h = entryHashOf([]);
    expect(h).toEqual(new Uint8Array(32));
  });

  test('same entries → same hash', () => {
    const entries = [
      { key: 'a', valueMsgpack: encodeValue(1) },
      { key: 'b', valueMsgpack: encodeValue(2) },
    ];
    const h1 = entryHashOf(entries);
    const h2 = entryHashOf(entries);
    expect(h1).toEqual(h2);
  });

  test('different entries → different hash', () => {
    const a = entryHashOf([{ key: 'x', valueMsgpack: encodeValue(1) }]);
    const b = entryHashOf([{ key: 'x', valueMsgpack: encodeValue(2) }]);
    expect(a).not.toEqual(b);
  });

  test('chunk-size independence: order-invariant (XOR commutative)', () => {
    const e1 = { key: 'a', valueMsgpack: encodeValue(1) };
    const e2 = { key: 'b', valueMsgpack: encodeValue(2) };
    const e3 = { key: 'c', valueMsgpack: encodeValue(3) };

    const all = entryHashOf([e1, e2, e3]);

    // Split into two "leaves" and combine
    const leaf1 = entryHashOf([e1, e2]);
    const leaf2 = entryHashOf([e3]);
    const combined = combineEntryHashes([leaf1, leaf2]);

    expect(combined).toEqual(all);
  });

  test('split differently → same combined hash', () => {
    const e1 = { key: 'a', valueMsgpack: encodeValue(1) };
    const e2 = { key: 'b', valueMsgpack: encodeValue(2) };
    const e3 = { key: 'c', valueMsgpack: encodeValue(3) };

    const all = entryHashOf([e1, e2, e3]);

    // Different chunking
    const splitA = combineEntryHashes([entryHashOf([e1]), entryHashOf([e2, e3])]);
    const splitB = combineEntryHashes([entryHashOf([e1, e2]), entryHashOf([e3])]);
    const splitC = combineEntryHashes([entryHashOf([e1]), entryHashOf([e2]), entryHashOf([e3])]);

    expect(splitA).toEqual(all);
    expect(splitB).toEqual(all);
    expect(splitC).toEqual(all);
  });
});

describe('chunkBlobKey', () => {
  test('uses first 2 hex chars as shard prefix', () => {
    const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as any;
    expect(chunkBlobKey(hash)).toBe('chunks/ab/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });
});
