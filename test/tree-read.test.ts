import { describe, test, expect } from 'vitest';
import { get, getRootHash } from '../src/tree-read.js';
import { put } from '../src/tree-write.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { BlobNotFoundError } from '../src/errors.js';
import { toKey, toPointer } from '../src/types.js';

const key = (s: string) => toKey(s);
const ptr = (s: string) => toPointer(s);

describe('getRootHash', () => {
  test('throws BlobNotFoundError for unknown key', async () => {
    const adapter = new MemoryStorageAdapter();
    await expect(getRootHash(key('nope'), adapter)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  test('returns a 64-char hex string after put', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);
    const hash = await getRootHash(key('doc'), adapter);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same document → same hash', async () => {
    const a = new MemoryStorageAdapter();
    const b = new MemoryStorageAdapter();
    await put(key('doc'), { x: 42, y: 'hello' }, a);
    await put(key('doc'), { x: 42, y: 'hello' }, b);
    expect(await getRootHash(key('doc'), a)).toBe(await getRootHash(key('doc'), b));
  });

  test('different documents → different hash', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('a'), { x: 1 }, adapter);
    await put(key('b'), { x: 2 }, adapter);
    const hashA = await getRootHash(key('a'), adapter);
    const hashB = await getRootHash(key('b'), adapter);
    expect(hashA).not.toBe(hashB);
  });
});

describe('get — full document', () => {
  test('throws BlobNotFoundError for unknown key', async () => {
    const adapter = new MemoryStorageAdapter();
    await expect(get(key('nope'), adapter)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  test('roundtrip: flat object', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { name: 'Alice', age: 30, active: true };
    await put(key('doc'), doc, adapter);
    const result = await get(key('doc'), adapter);
    expect(result).toEqual(doc);
  });

  test('roundtrip: nested object', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { player: { name: 'Bob', stats: { era: 2.5, wins: 10 } } };
    await put(key('doc'), doc, adapter);
    expect(await get(key('doc'), adapter)).toEqual(doc);
  });

  test('roundtrip: array in object', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { scores: [10, 20, 30], labels: ['a', 'b'] };
    await put(key('doc'), doc, adapter);
    expect(await get(key('doc'), adapter)).toEqual(doc);
  });

  test('roundtrip: null values', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { a: null, b: { c: null } };
    await put(key('doc'), doc, adapter);
    expect(await get(key('doc'), adapter)).toEqual(doc);
  });

  test('roundtrip: empty array', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { items: [] };
    await put(key('doc'), doc, adapter);
    expect(await get(key('doc'), adapter)).toEqual(doc);
  });
});

describe('get — with pointer', () => {
  test('returns sub-value at pointer path', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { player: { name: 'Alice', age: 25 } }, adapter);
    const name = await get(key('doc'), adapter, ptr('/player/name'));
    expect(name).toBe('Alice');
  });

  test('returns nested object at pointer', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { player: { name: 'Alice', stats: { era: 1.5 } } }, adapter);
    const stats = await get(key('doc'), adapter, ptr('/player/stats'));
    expect(stats).toEqual({ era: 1.5 });
  });

  test('returns array element at numeric index', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { items: ['x', 'y', 'z'] }, adapter);
    expect(await get(key('doc'), adapter, ptr('/items/1'))).toBe('y');
  });
});
