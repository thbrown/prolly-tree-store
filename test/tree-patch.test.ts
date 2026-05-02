import { describe, test, expect } from 'vitest';
import { patch } from '../src/tree-patch.js';
import { put } from '../src/tree-write.js';
import { get } from '../src/tree-read.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { BlobNotFoundError, PatchTestFailedError } from '../src/errors.js';
import { toKey, toPatch } from '../src/types.js';

const key = (s: string) => toKey(s);
const p = (ops: object[]) => toPatch(JSON.stringify(ops));

describe('patch', () => {
  test('throws BlobNotFoundError if key does not exist', async () => {
    const adapter = new MemoryStorageAdapter();
    await expect(
      patch(key('nope'), p([{ op: 'replace', path: '/x', value: 1 }]), adapter)
    ).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  test('add operation', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);
    await patch(key('doc'), p([{ op: 'add', path: '/b', value: 2 }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ a: 1, b: 2 });
  });

  test('replace operation', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1, b: 2 }, adapter);
    await patch(key('doc'), p([{ op: 'replace', path: '/a', value: 99 }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ a: 99, b: 2 });
  });

  test('remove operation', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1, b: 2 }, adapter);
    await patch(key('doc'), p([{ op: 'remove', path: '/b' }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ a: 1 });
  });

  test('returns new ContentHash', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);
    const hash = await patch(key('doc'), p([{ op: 'replace', path: '/a', value: 2 }]), adapter);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('test op passes — mutation proceeds', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);
    await patch(key('doc'), p([
      { op: 'test', path: '/a', value: 1 },
      { op: 'replace', path: '/a', value: 99 },
    ]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ a: 99 });
  });

  test('failing test op throws PatchTestFailedError, document unchanged', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);

    await expect(
      patch(key('doc'), p([
        { op: 'test', path: '/a', value: 999 }, // wrong value
        { op: 'replace', path: '/a', value: 0 },
      ]), adapter)
    ).rejects.toBeInstanceOf(PatchTestFailedError);

    // Document must be unchanged
    expect(await get(key('doc'), adapter)).toEqual({ a: 1 });
  });

  test('PatchTestFailedError carries pointer, expected, actual', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { x: 'actual' }, adapter);

    try {
      await patch(key('doc'), p([{ op: 'test', path: '/x', value: 'expected' }]), adapter);
    } catch (e) {
      expect(e).toBeInstanceOf(PatchTestFailedError);
      const err = e as PatchTestFailedError;
      expect(err.pointer).toBe('/x');
      expect(err.expected).toBe('expected');
      expect(err.actual).toBe('actual');
    }
  });

  test('nested replace', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { player: { name: 'Alice', score: 10 } }, adapter);
    await patch(key('doc'), p([{ op: 'replace', path: '/player/score', value: 20 }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ player: { name: 'Alice', score: 20 } });
  });

  test('replace scalar with object (schema change — adds new tree keys)', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { x: 1, y: 2 }, adapter);
    await patch(key('doc'), p([{ op: 'replace', path: '/x', value: { a: 10, b: 20 } }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ x: { a: 10, b: 20 }, y: 2 });
  });

  test('replace object with scalar (schema change — removes old tree keys)', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { player: { name: 'Alice', score: 10 }, active: true }, adapter);
    await patch(key('doc'), p([{ op: 'replace', path: '/player', value: 'Bob' }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ player: 'Bob', active: true });
  });

  test('remove nested object deletes all sub-keys', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { config: { host: 'localhost', port: 8080 }, name: 'app' }, adapter);
    await patch(key('doc'), p([{ op: 'remove', path: '/config' }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ name: 'app' });
  });

  test('add nested object inserts all sub-keys', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { name: 'app' }, adapter);
    await patch(key('doc'), p([{ op: 'add', path: '/config', value: { host: 'localhost', port: 8080 } }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ name: 'app', config: { host: 'localhost', port: 8080 } });
  });

  test('multiple ops in one patch applied in order', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1, b: 2, c: 3 }, adapter);
    await patch(key('doc'), p([
      { op: 'replace', path: '/a', value: 10 },
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/d', value: 4 },
    ]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ a: 10, c: 3, d: 4 });
  });

  test('array element replace', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { scores: [10, 20, 30] }, adapter);
    await patch(key('doc'), p([{ op: 'replace', path: '/scores/1', value: 99 }]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ scores: [10, 99, 30] });
  });

  test('incremental patch writes fewer blobs than a full put on a large doc', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc: Record<string, number> = {};
    for (let i = 0; i < 100; i++) doc[`k${i}`] = i;

    await put(key('doc'), doc, adapter, { chunkSize: 256 });
    const blobsAfterPut = adapter.size;

    // Spy on persistBlob to count writes during the patch
    let patchWrites = 0;
    const original = adapter.persistBlob.bind(adapter);
    adapter.persistBlob = async (...args) => { patchWrites++; return original(...args); };

    // Change one key — should only rewrite O(log n) blobs, not all 100
    await patch(key('doc'), p([{ op: 'replace', path: '/k50', value: 9999 }]), adapter);

    // Full put would write ~50+ blobs; incremental patch should write far fewer
    expect(patchWrites).toBeLessThan(10);
  });

  test('empty patch is a no-op', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('doc'), { a: 1 }, adapter);
    const hash1 = await patch(key('doc'), p([]), adapter);
    expect(await get(key('doc'), adapter)).toEqual({ a: 1 });
    // Hash should be unchanged (same content)
    const { getRootHash } = await import('../src/tree-read.js');
    expect(await getRootHash(key('doc'), adapter)).toBe(hash1);
  });
});
