import { describe, test, expect, vi } from 'vitest';
import { put, remove } from '../src/tree-write.js';
import { get, getRootHash } from '../src/tree-read.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { toKey } from '../src/types.js';

const key = (s: string) => toKey(s);

describe('put', () => {
  test('returns a 64-char hex ContentHash', async () => {
    const adapter = new MemoryStorageAdapter();
    const hash = await put(key('doc'), { a: 1 }, adapter);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('put then get roundtrip', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { name: 'Alice', score: 100, active: true };
    await put(key('doc'), doc, adapter);
    expect(await get(key('doc'), adapter)).toEqual(doc);
  });

  test('second put with same content returns same hash', async () => {
    const adapter = new MemoryStorageAdapter();
    const hash1 = await put(key('doc'), { x: 1 }, adapter);
    const hash2 = await put(key('doc'), { x: 1 }, adapter);
    expect(hash1).toBe(hash2);
  });

  test('put replaces existing document', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { old: true }, adapter);
    await put(key('doc'), { new: true }, adapter);
    expect(await get(key('doc'), adapter)).toEqual({ new: true });
  });

  test('different chunkSizes produce same entryHash', async () => {
    const adapterA = new MemoryStorageAdapter();
    const adapterB = new MemoryStorageAdapter();
    const doc = { players: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }], season: 2024 };

    const hashA = await put(key('doc'), doc, adapterA, { chunkSize: 128 });
    const hashB = await put(key('doc'), doc, adapterB, { chunkSize: 4096 });

    expect(hashA).toBe(hashB);
  });

  test('dedup: unchanged blobs not re-written on second put to same key', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { a: 1, b: 2, c: 3 };

    await put(key('doc'), doc, adapter);

    const spy = vi.spyOn(adapter, 'persistBlob');
    await put(key('doc'), doc, adapter);

    // All chunks already exist under chunks/doc/ — none should be re-written
    const chunkWrites = spy.mock.calls.filter(([k]) => (k as string).includes('/chunks/')).length;
    expect(chunkWrites).toBe(0);
  });
});

describe('remove', () => {
  test('no-ops when key does not exist', async () => {
    const adapter = new MemoryStorageAdapter();
    await expect(remove(key('nope'), adapter)).resolves.toBeUndefined();
  });

  test('removes all blobs for the document', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);
    expect(adapter.size).toBeGreaterThan(0);

    await remove(key('doc'), adapter);
    expect(adapter.size).toBe(0);
  });

  test('after remove, get throws BlobNotFoundError', async () => {
    const adapter = new MemoryStorageAdapter();
    const { BlobNotFoundError } = await import('../src/errors.js');
    await put(key('doc'), { x: 99 }, adapter);
    await remove(key('doc'), adapter);
    await expect(get(key('doc'), adapter)).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});
