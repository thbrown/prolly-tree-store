/**
 * compact() and gc() — the maintenance operations that keep storage bounded.
 */

import { describe, test, expect } from 'vitest';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import type { JSONValue, KeyString, JSONBlob } from '../src/types.js';

const K = (s: string) => ProllyTreeStore.asKey(s);
const patchOps = (ops: unknown[]) => JSON.stringify(ops) as never;

const CHUNK_SIZE = 512;

function makeStore(options: { retainStaleChunks?: boolean } = {}) {
  const adapter = new MemoryStorageAdapter();
  const store = new ProllyTreeStore({
    adapter,
    initialState: { chunkSize: CHUNK_SIZE } as never,
    ...options,
  });
  return { adapter, store };
}

const chunkKeys = (adapter: MemoryStorageAdapter, doc: string) =>
  adapter.keys().filter(k => k.startsWith(`chunks/${doc}/`));

const blobSizes = (adapter: MemoryStorageAdapter, doc: string) =>
  chunkKeys(adapter, doc).map(k => (adapter as unknown as { store: Map<string, string> }).store.get(k)!.length);

describe('compact', () => {
  test('restores the canonical chunk layout after patch-driven growth', async () => {
    const { adapter, store } = makeStore();
    const element = (i: number) => ({ id: i, name: `player${i}`, stats: { ab: i, h: i % 7 } });

    await store.put(K('d'), { roster: [element(0)] });

    for (let i = 1; i < 120; i++) {
      await store.patch(K('d'), patchOps([{ op: 'add', path: '/roster/-', value: element(i) }]));
    }

    const driftedMax = Math.max(...blobSizes(adapter, 'd'));
    const driftedCount = chunkKeys(adapter, 'd').length;
    const before = await store.get(K('d'));

    // patch alone lets a single leaf grow far past the target chunk size
    expect(driftedMax).toBeGreaterThan(CHUNK_SIZE * 4);

    const hash = await store.compact(K('d'));

    // Content and identity are unchanged; only the layout differs.
    expect(await store.get(K('d'))).toEqual(before);
    expect(hash).toBe(await store.getRootHash(K('d')));

    const compactedMax = Math.max(...blobSizes(adapter, 'd'));
    expect(compactedMax).toBeLessThan(driftedMax / 2);
    expect(chunkKeys(adapter, 'd').length).toBeGreaterThan(driftedCount);
  });

  test('compacting an already canonical document changes nothing observable', async () => {
    const { store } = makeStore();
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 200; i++) doc[`k${String(i).padStart(4, '0')}`] = i;

    await store.put(K('d'), doc);
    const before = await store.getRootHash(K('d'));

    expect(await store.compact(K('d'))).toBe(before);
    expect(await store.get(K('d'))).toEqual(doc);
  });
});

describe('gc', () => {
  test('reclaims chunks orphaned by an interrupted put', async () => {
    const { adapter, store } = makeStore();
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 80; i++) doc[`k${i}`] = i;

    await store.put(K('d'), doc);
    const healthy = chunkKeys(adapter, 'd').length;

    // Fail the root pointer write: chunks land, the commit does not.
    const original = adapter.persistBlob.bind(adapter);
    adapter.persistBlob = async (key: KeyString, value: JSONBlob) => {
      if ((key as string).startsWith('__root__')) throw new Error('simulated crash');
      return original(key, value);
    };
    await expect(store.put(K('d'), { ...doc, k0: 'changed' })).rejects.toThrow('simulated crash');
    adapter.persistBlob = original;

    expect(chunkKeys(adapter, 'd').length).toBeGreaterThan(healthy);
    // The document still reads as the last committed version.
    expect(await store.get(K('d'))).toEqual(doc);

    const reclaimed = await store.gc(K('d'));

    expect(reclaimed).toBeGreaterThan(0);
    expect(chunkKeys(adapter, 'd').length).toBe(healthy);
    expect(await store.get(K('d'))).toEqual(doc);
  });

  test('reclaims chunks retained on purpose by retainStaleChunks', async () => {
    const { adapter, store } = makeStore({ retainStaleChunks: true });
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 80; i++) doc[`k${i}`] = i;

    await store.put(K('d'), doc);
    const first = chunkKeys(adapter, 'd').length;

    await store.put(K('d'), { ...doc, k0: 'changed' });

    // The previous version's chunks are still readable by an in-flight reader.
    expect(chunkKeys(adapter, 'd').length).toBeGreaterThan(first);

    await store.gc(K('d'));
    expect(await store.get(K('d'))).toEqual({ ...doc, k0: 'changed' });
    expect(chunkKeys(adapter, 'd').length).toBeLessThanOrEqual(first + 2);
  });

  test('after delete, gc clears everything under the document prefix', async () => {
    const { adapter, store } = makeStore();
    await store.put(K('d'), { a: 1, b: [1, 2, 3] });
    await store.delete(K('d'));

    expect(await store.gc(K('d'))).toBe(0);
    expect(chunkKeys(adapter, 'd')).toEqual([]);
  });

  test('gc keeps every chunk a live document needs', async () => {
    const { adapter, store } = makeStore();
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 150; i++) doc[`k${String(i).padStart(4, '0')}`] = { v: i };

    await store.put(K('d'), doc);
    for (let i = 0; i < 10; i++) {
      await store.patch(K('d'), patchOps([{ op: 'replace', path: `/k${String(i * 11).padStart(4, '0')}/v`, value: -i - 1 }]));
    }

    const before = chunkKeys(adapter, 'd').length;
    await store.gc(K('d'));

    // Patches already clean up after themselves, so gc has little to reclaim,
    // and the document must still read back intact.
    expect(chunkKeys(adapter, 'd').length).toBeLessThanOrEqual(before);
    const readBack = (await store.get(K('d'))) as Record<string, { v: number }>;
    expect(readBack.k0000.v).toBe(-1);
    expect(readBack.k0149.v).toBe(149);
    expect(Object.keys(readBack)).toHaveLength(150);
  });

  test('gc explains itself when the adapter cannot list blobs', async () => {
    const adapter = new MemoryStorageAdapter();
    delete (adapter as { listBlobs?: unknown }).listBlobs;
    const limited = {
      persistBlob: adapter.persistBlob.bind(adapter),
      readBlob: adapter.readBlob.bind(adapter),
      deleteBlob: adapter.deleteBlob.bind(adapter),
    };
    const store = new ProllyTreeStore({
      adapter: limited,
      initialState: { chunkSize: CHUNK_SIZE } as never,
    });

    await store.put(K('d'), { a: 1 });
    await expect(store.gc(K('d'))).rejects.toThrow(/listBlobs/);
  });
});
