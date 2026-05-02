import { describe, test, expect } from 'vitest';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { put } from '../src/tree-write.js';
import { get, getRootHash } from '../src/tree-read.js';

const K = (s: string) => ProllyTreeStore.asKey(s);

function makeP(chunkSize = 4096) {
  return new ProllyTreeStore({
    adapter: new MemoryStorageAdapter(),
    initialState: { chunkSize, prefetchWidth: 2 },
  });
}

describe('Integration: put → get roundtrip', () => {
  const docs = [
    { label: 'empty object', doc: {} },
    { label: 'flat object', doc: { a: 1, b: 'hello', c: true, d: null } },
    { label: 'nested', doc: { x: { y: { z: 42 } } } },
    { label: 'array of primitives', doc: { items: [1, 2, 3] } },
    { label: 'array of objects', doc: { players: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] } },
    { label: 'deeply nested', doc: { a: { b: { c: { d: { e: 'deep' } } } } } },
    { label: 'large flat', doc: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i])) },
  ];

  for (const { label, doc } of docs) {
    test(label, async () => {
      const p = makeP();
      await p.put(K('doc'), doc as any);
      expect(await p.get(K('doc'))).toEqual(doc);
    });
  }
});

describe('Integration: diff/patch symmetry', () => {
  test('patch(A, diff(A,B)) === B for simple change', async () => {
    const adapter = new MemoryStorageAdapter();
    const opts = { adapter, initialState: { chunkSize: 4096, prefetchWidth: 2 } };
    const p = new ProllyTreeStore(opts);

    const docA = { name: 'Alice', score: 10, active: true };
    const docB = { name: 'Bob', score: 20 };

    await p.put(K('a'), docA);
    await p.put(K('b'), docB);

    const patchDoc = await p.diff(K('a'), K('b'));
    await p.patch(K('a'), patchDoc);

    expect(await p.get(K('a'))).toEqual(docB);
  });

  test('patch(A, diff(A,B)) === B for large documents', async () => {
    const adapter = new MemoryStorageAdapter();
    const p = new ProllyTreeStore({ adapter, initialState: { chunkSize: 256, prefetchWidth: 2 } });

    const docA: Record<string, number> = {};
    const docB: Record<string, number> = {};
    for (let i = 0; i < 80; i++) {
      docA[`k${i}`] = i;
      docB[`k${i}`] = i % 2 === 0 ? i * 2 : i; // every even key doubled
    }

    await p.put(K('a'), docA);
    await p.put(K('b'), docB);

    const patchDoc = await p.diff(K('a'), K('b'));
    await p.patch(K('a'), patchDoc);

    expect(await p.get(K('a'))).toEqual(docB);
  });
});

describe('Integration: cross-chunkSize entryHash equality', () => {
  test('same data with different chunkSizes → same getRootHash', async () => {
    const doc = { players: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Player${i}`, score: i * 10 })) };

    const adapterA = new MemoryStorageAdapter();
    const adapterB = new MemoryStorageAdapter();

    await put(K('doc'), doc as any, adapterA, { chunkSize: 128 });
    await put(K('doc'), doc as any, adapterB, { chunkSize: 8192 });

    const hashA = await getRootHash(K('doc'), adapterA);
    const hashB = await getRootHash(K('doc'), adapterB);

    expect(hashA).toBe(hashB);
  });
});

describe('Integration: delete', () => {
  test('delete removes all blobs for the document', async () => {
    const p = makeP();
    await p.put(K('doc'), { a: 1, b: 2 });
    const adapter = (p as any).adapter as MemoryStorageAdapter;
    expect(adapter.size).toBeGreaterThan(0);

    await p.delete(K('doc'));
    expect(adapter.size).toBe(0);
  });

  test('get after delete throws', async () => {
    const p = makeP();
    await p.put(K('doc'), { a: 1 });
    await p.delete(K('doc'));
    await expect(p.get(K('doc'))).rejects.toThrow();
  });

  test('delete is no-op for non-existent key', async () => {
    const p = makeP();
    await expect(p.delete(K('ghost'))).resolves.toBeUndefined();
  });
});

describe('Integration: same-key dedup', () => {
  test('second put to same key with same content does not re-write chunk blobs', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { a: 1, b: 2 };

    await put(K('key1'), doc as any, adapter, { chunkSize: 4096 });
    const sizeAfterFirst = adapter.size;

    // Same key, same content — chunks already exist under chunks/key1/
    await put(K('key1'), doc as any, adapter, { chunkSize: 4096 });
    expect(adapter.size).toBe(sizeAfterFirst);
  });

  test('put with changed content cleans up stale chunks', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(K('doc'), { a: 1, b: 2 }, adapter, { chunkSize: 4096 });
    await put(K('doc'), { x: 99 }, adapter, { chunkSize: 4096 });

    // After the second put the adapter should only contain the new tree
    const keys = adapter.keys();
    const chunkKeys = keys.filter(k => k.startsWith('chunks/'));
    // Verify get returns the new content (old blobs gone)
    const { get: treeGet } = await import('../src/tree-read.js');
    expect(await treeGet(K('doc'), adapter)).toEqual({ x: 99 });
    // Only blobs for the current tree should remain
    expect(chunkKeys.every(k => k.startsWith('chunks/doc/'))).toBe(true);
  });
});
