import { describe, test, expect, vi } from 'vitest';
import { put, remove } from '../src/tree-write.js';
import { get, getRootHash } from '../src/tree-read.js';
import { patch } from '../src/tree-patch.js';
import { diff } from '../src/tree-diff.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { toKey, toPatch, toPointer } from '../src/types.js';

const k = (s: string) => toKey(s);
const p = (ops: object[]) => toPatch(JSON.stringify(ops));
const ptr = (s: string) => toPointer(s);

// Small chunk size forces a multi-level tree even for moderate document sizes,
// making complexity differences visible in small tests.
const CHUNK_SIZE = 256;

function makeDoc(n: number): Record<string, string> {
  const doc: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    doc[`key_${String(i).padStart(6, '0')}`] = `value_${i}`;
  }
  return doc;
}

// Count total reads across both the single-key and batch read paths.
function countReads(
  readBlobSpy: ReturnType<typeof vi.spyOn>,
  readBlobsSpy: ReturnType<typeof vi.spyOn>,
): number {
  const singles = readBlobSpy.mock.calls.length;
  const batches = (readBlobsSpy.mock.calls as unknown as [string[]][]).reduce(
    (sum, [keys]) => sum + keys.length,
    0,
  );
  return singles + batches;
}

describe('complexity', () => {
  describe('getRootHash — O(1) reads', () => {
    test('reads exactly 1 blob regardless of document size', async () => {
      for (const n of [10, 100, 1000]) {
        const adapter = new MemoryStorageAdapter();
        await put(k(`doc_${n}`), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });

        const readSpy = vi.spyOn(adapter, 'readBlob');
        const batchSpy = vi.spyOn(adapter, 'readBlobs');

        await getRootHash(k(`doc_${n}`), adapter);

        expect(countReads(readSpy, batchSpy)).toBe(1);

        readSpy.mockRestore();
        batchSpy.mockRestore();
      }
    });
  });

  describe('get — O(log n) reads with pointer', () => {
    // Full get must read all leaf nodes to reconstruct the document (O(n/fanout)).
    // The O(log n) property applies to pointer-scoped reads: only the root-to-leaf
    // path matching the pointer is traversed.

    test('get with pointer reads far fewer blobs than a full get on the same document', async () => {
      const adapter = new MemoryStorageAdapter();
      await put(k('doc'), makeDoc(500), adapter, { chunkSize: CHUNK_SIZE });

      const fullReadSpy = vi.spyOn(adapter, 'readBlob');
      const fullBatchSpy = vi.spyOn(adapter, 'readBlobs');
      await get(k('doc'), adapter);
      const fullReads = countReads(fullReadSpy, fullBatchSpy);
      fullReadSpy.mockRestore();
      fullBatchSpy.mockRestore();

      const ptrReadSpy = vi.spyOn(adapter, 'readBlob');
      const ptrBatchSpy = vi.spyOn(adapter, 'readBlobs');
      await get(k('doc'), adapter, ptr('/key_000250'));
      const ptrReads = countReads(ptrReadSpy, ptrBatchSpy);
      ptrReadSpy.mockRestore();
      ptrBatchSpy.mockRestore();

      // Pointer get traverses only a single root-to-leaf path
      expect(ptrReads).toBeLessThan(fullReads / 2);
    });

    test('pointer get read count grows much slower than document size (O(log n))', async () => {
      const readCounts: number[] = [];

      for (const n of [50, 500]) {
        const adapter = new MemoryStorageAdapter();
        await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });

        const readSpy = vi.spyOn(adapter, 'readBlob');
        const batchSpy = vi.spyOn(adapter, 'readBlobs');

        // Always fetch the middle entry
        const midKey = `key_${String(Math.floor(n / 2)).padStart(6, '0')}`;
        await get(k('doc'), adapter, ptr(`/${midKey}`));
        readCounts.push(countReads(readSpy, batchSpy));

        readSpy.mockRestore();
        batchSpy.mockRestore();
      }

      const [reads50, reads500] = readCounts;
      // 10x more entries → logarithmic growth, not 10x more reads
      expect(reads500).toBeLessThan(reads50 * 5);
      expect(reads500).toBeGreaterThanOrEqual(reads50); // but does grow
    });
  });

  describe('put — O(n) writes', () => {
    test('write count grows approximately linearly with document size', async () => {
      const writeCounts: number[] = [];

      for (const n of [50, 500]) {
        const adapter = new MemoryStorageAdapter();
        const writeSpy = vi.spyOn(adapter, 'persistBlob');
        await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
        writeCounts.push(writeSpy.mock.calls.length);
        writeSpy.mockRestore();
      }

      const [writes50, writes500] = writeCounts;
      // 10x more entries → 5–25x more writes (linear, not logarithmic or quadratic)
      const ratio = writes500 / writes50;
      expect(ratio).toBeGreaterThan(5);
      expect(ratio).toBeLessThan(25);
    });
  });

  describe('patch — O(log n) writes for sparse mutations', () => {
    test('patching one field writes far fewer chunks than a full put', async () => {
      const adapter = new MemoryStorageAdapter();
      const n = 500;

      const putSpy = vi.spyOn(adapter, 'persistBlob');
      await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
      const putWrites = putSpy.mock.calls.filter(([key]) =>
        (key as string).startsWith('chunks/'),
      ).length;
      putSpy.mockRestore();

      const patchSpy = vi.spyOn(adapter, 'persistBlob');
      await patch(k('doc'), p([{ op: 'replace', path: '/key_000250', value: 'updated' }]), adapter);
      const patchWrites = patchSpy.mock.calls.filter(([key]) =>
        (key as string).startsWith('chunks/'),
      ).length;
      patchSpy.mockRestore();

      // Patch rewrites only the modified node and its ancestors (O(log n));
      // a full put rewrites all O(n) nodes.
      expect(patchWrites).toBeLessThan(putWrites / 10);
      // Concrete ceiling: tree height for n=500 with chunkSize=256 is a few levels
      expect(patchWrites).toBeLessThan(30);
    });

    test('write count scales with m (affected entries) but collapses shared ancestors', async () => {
      const adapter = new MemoryStorageAdapter();
      await put(k('doc'), makeDoc(500), adapter, { chunkSize: CHUNK_SIZE });

      const spy1 = vi.spyOn(adapter, 'persistBlob');
      await patch(k('doc'), p([{ op: 'replace', path: '/key_000000', value: 'v' }]), adapter);
      const writes1 = spy1.mock.calls.filter(([key]) =>
        (key as string).startsWith('chunks/'),
      ).length;
      spy1.mockRestore();

      const patches50 = Array.from({ length: 50 }, (_, i) => ({
        op: 'replace' as const,
        path: `/key_${String(i * 10).padStart(6, '0')}`,
        value: `updated_${i}`,
      }));
      const spy50 = vi.spyOn(adapter, 'persistBlob');
      await patch(k('doc'), p(patches50), adapter);
      const writes50 = spy50.mock.calls.filter(([key]) =>
        (key as string).startsWith('chunks/'),
      ).length;
      spy50.mockRestore();

      // More affected entries → more writes, but shared ancestors are written only once
      expect(writes50).toBeGreaterThan(writes1);
      expect(writes50).toBeLessThan(writes1 * 50);
    });
  });

  describe('diff — O(d) reads where d = changed entries', () => {
    test('identical documents short-circuit via hash pruning — far fewer reads than O(n)', async () => {
      const n = 500;
      const adapter = new MemoryStorageAdapter();
      const doc = makeDoc(n);
      await put(k('a'), doc, adapter, { chunkSize: CHUNK_SIZE });
      await put(k('b'), doc, adapter, { chunkSize: CHUNK_SIZE });

      const readSpy = vi.spyOn(adapter, 'readBlob');
      const batchSpy = vi.spyOn(adapter, 'readBlobs');

      const result = await diff(k('a'), k('b'), adapter);
      const reads = countReads(readSpy, batchSpy);

      readSpy.mockRestore();
      batchSpy.mockRestore();

      expect(result).toBe('[]');
      // Hash equality prunes unchanged subtrees — reads should be well under n
      expect(reads).toBeLessThan(n / 4);
    });

    test('read count scales with d (changed entries), not with total document size n', async () => {
      const adapter = new MemoryStorageAdapter();
      const base = makeDoc(500);
      await put(k('base'), base, adapter, { chunkSize: CHUNK_SIZE });

      const mod1 = { ...base, key_000000: 'changed' };
      await put(k('mod1'), mod1, adapter, { chunkSize: CHUNK_SIZE });

      // 20 changes spread across the key space
      const mod20 = { ...base };
      for (let i = 0; i < 20; i++) {
        mod20[`key_${String(i * 25).padStart(6, '0')}`] = `changed_${i}`;
      }
      await put(k('mod20'), mod20, adapter, { chunkSize: CHUNK_SIZE });

      const spy1 = vi.spyOn(adapter, 'readBlob');
      const batchSpy1 = vi.spyOn(adapter, 'readBlobs');
      await diff(k('base'), k('mod1'), adapter);
      const reads1 = countReads(spy1, batchSpy1);
      spy1.mockRestore();
      batchSpy1.mockRestore();

      const spy20 = vi.spyOn(adapter, 'readBlob');
      const batchSpy20 = vi.spyOn(adapter, 'readBlobs');
      await diff(k('base'), k('mod20'), adapter);
      const reads20 = countReads(spy20, batchSpy20);
      spy20.mockRestore();
      batchSpy20.mockRestore();

      // More changes → more reads, but both well under O(n) = 500
      expect(reads20).toBeGreaterThan(reads1);
      expect(reads20).toBeLessThan(400);
    });
  });

  describe('delete — full chunk cleanup', () => {
    test('remove restores adapter blob count to pre-put baseline', async () => {
      const adapter = new MemoryStorageAdapter();
      const baseline = adapter.size;

      await put(k('doc'), makeDoc(200), adapter, { chunkSize: CHUNK_SIZE });
      expect(adapter.size).toBeGreaterThan(baseline);

      await remove(k('doc'), adapter);
      expect(adapter.size).toBe(baseline);
    });

    test('larger documents leave more blobs, all of which are cleaned up', async () => {
      const adapter = new MemoryStorageAdapter();

      await put(k('small'), makeDoc(10), adapter, { chunkSize: CHUNK_SIZE });
      const sizeAfterSmall = adapter.size;

      await put(k('large'), makeDoc(500), adapter, { chunkSize: CHUNK_SIZE });
      const largeDocBlobCount = adapter.size - sizeAfterSmall;

      // Large doc has significantly more blobs than small doc
      expect(largeDocBlobCount).toBeGreaterThan(sizeAfterSmall * 5);

      // All large-doc blobs are cleaned up on remove
      await remove(k('large'), adapter);
      expect(adapter.size).toBe(sizeAfterSmall);

      await remove(k('small'), adapter);
      expect(adapter.size).toBe(0);
    });
  });
});
