/**
 * compact() and gc() — the maintenance operations that keep storage bounded.
 */

import { describe, test, expect } from 'vitest';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import type { JSONValue, KeyString, JSONBlob } from '../src/types.js';
import { decodeRootPointer } from '../src/serialization.js';
import { toHex } from '../src/hashing.js';

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

/** chunkHash of a document's root node, which identifies its exact layout. */
async function rootChunkHash(store: ProllyTreeStore, key: ReturnType<typeof K>): Promise<string> {
  const adapter = (store as unknown as { adapter: MemoryStorageAdapter }).adapter;
  const blob = await adapter.readBlob(`__root__/${key as string}` as never);
  return toHex(decodeRootPointer(blob).chunkHash);
}

const blobSizes = (adapter: MemoryStorageAdapter, doc: string) =>
  chunkKeys(adapter, doc).map(k => (adapter as unknown as { store: Map<string, string> }).store.get(k)!.length);

describe('patch re-chunking', () => {
  const element = (i: number) => ({ id: i, name: `player${i}`, stats: { ab: i, h: i % 7 } });

  test('appending through patch keeps chunks bounded and grows the tree', async () => {
    const { adapter, store } = makeStore();

    await store.put(K('d'), { roster: [element(0)] });
    const startCount = chunkKeys(adapter, 'd').length;

    for (let i = 1; i < 200; i++) {
      await store.patch(K('d'), patchOps([{ op: 'add', path: '/roster/-', value: element(i) }]));
    }

    const sizes = blobSizes(adapter, 'd');
    const count = chunkKeys(adapter, 'd').length;

    // Before leaves could split, one leaf absorbed every append and grew without
    // bound while the chunk count stayed flat, so each append rewrote the lot.
    expect(count).toBeGreaterThan(startCount * 5);
    expect(Math.max(...sizes)).toBeLessThan(CHUNK_SIZE * 10);

    const roster = (await store.get(K('d'))) as { roster: Array<{ id: number }> };
    expect(roster.roster).toHaveLength(200);
    expect(roster.roster[199].id).toBe(199);
  });

  test('removing everything through patch leaves no stranded nodes', async () => {
    const { adapter, store } = makeStore();
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 120; i++) doc[`k${String(i).padStart(4, '0')}`] = { v: i };

    await store.put(K('d'), doc);
    expect(chunkKeys(adapter, 'd').length).toBeGreaterThan(10);

    for (let i = 0; i < 120; i++) {
      await store.patch(K('d'), patchOps([{ op: 'remove', path: `/k${String(i).padStart(4, '0')}` }]));
    }

    expect(await store.get(K('d'))).toEqual({});
    // Emptied leaves are dropped rather than kept as empty nodes, so the tree
    // collapses back down instead of retaining one husk per removal.
    await store.gc(K('d'));
    expect(chunkKeys(adapter, 'd').length).toBeLessThan(5);
  });
});

describe('compact', () => {
  const element = (i: number) => ({ id: i, name: `player${i}`, stats: { ab: i, h: i % 7 } });

  test('restores exactly the layout a fresh put would produce', async () => {
    const { store } = makeStore();

    await store.put(K('d'), { roster: [element(0)] });
    for (let i = 1; i < 60; i++) {
      await store.patch(K('d'), patchOps([{ op: 'add', path: '/roster/-', value: element(i) }]));
      await store.patch(K('d'), patchOps([{ op: 'replace', path: `/roster/${i - 1}/stats/h`, value: i }]));
    }
    // A few removals too, which is what leaves the layout non-canonical:
    // merging an undersized node needs its neighbour, which lives outside the
    // node being rewritten, so patch cannot do it.
    await store.patch(K('d'), patchOps([{ op: 'remove', path: '/roster/3' }]));
    await store.patch(K('d'), patchOps([{ op: 'remove', path: '/roster/17' }]));

    const before = await store.get(K('d'));
    const hashBefore = await store.getRootHash(K('d'));

    await store.compact(K('d'));

    expect(await store.get(K('d'))).toEqual(before);
    // Compacting cannot change the content hash — it only re-chunks.
    expect(await store.getRootHash(K('d'))).toBe(hashBefore);

    // And the result is byte-identical in structure to building from scratch.
    await store.put(K('fresh'), JSON.parse(JSON.stringify(before)));
    expect(await rootChunkHash(store, K('d'))).toBe(await rootChunkHash(store, K('fresh')));
  });

  test('a patched document keeps the same content hash even when its layout differs', async () => {
    // The sync invariant does not depend on layout: two stores that reach the
    // same content by different routes agree on the root hash and diff to
    // nothing, whatever shape their trees are in.
    const { store } = makeStore();

    await store.put(K('patched'), { xs: [0, 1, 2, 3, 4, 5, 6, 7] });
    await store.patch(K('patched'), patchOps([
      { op: 'remove', path: '/xs/0' },
      { op: 'add', path: '/xs/-', value: 8 },
    ]));

    await store.put(K('direct'), { xs: [1, 2, 3, 4, 5, 6, 7, 8] });

    expect(await store.get(K('patched'))).toEqual(await store.get(K('direct')));
    expect(await store.getRootHash(K('patched'))).toBe(await store.getRootHash(K('direct')));
    expect(await store.diff(K('patched'), K('direct'))).toBe('[]');
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

  test('retainStaleChunks defers deletion on patch, not just put', async () => {
    const { adapter, store } = makeStore({ retainStaleChunks: true });
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 80; i++) doc[`k${i}`] = i;

    await store.put(K('d'), doc);
    const before = new Set(chunkKeys(adapter, 'd'));

    await store.patch(K('d'), patchOps([{ op: 'replace', path: '/k0', value: 'changed' }]));

    // Every chunk the previous version used is still there, so a reader that
    // is midway through it — another tab, or a document sharing these chunks —
    // does not hit a dangling pointer.
    const after = new Set(chunkKeys(adapter, 'd'));
    for (const key of before) expect(after.has(key)).toBe(true);
    expect(after.size).toBeGreaterThan(before.size);

    await store.gc(K('d'));
    expect(await store.get(K('d'))).toEqual({ ...doc, k0: 'changed' });
    expect(chunkKeys(adapter, 'd').length).toBeLessThanOrEqual(before.size + 2);
  });

  test('patch still deletes replaced chunks by default', async () => {
    const { adapter, store } = makeStore();
    const doc: Record<string, JSONValue> = {};
    for (let i = 0; i < 80; i++) doc[`k${i}`] = i;

    await store.put(K('d'), doc);
    const before = chunkKeys(adapter, 'd').length;

    await store.patch(K('d'), patchOps([{ op: 'replace', path: '/k0', value: 'changed' }]));

    expect(chunkKeys(adapter, 'd').length).toBeLessThanOrEqual(before + 1);
    expect(await store.gc(K('d'))).toBe(0);
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
