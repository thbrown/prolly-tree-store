import { describe, test, expect } from 'vitest';
import { MemoryStorageAdapter } from '../../src/adapters/memory.js';
import { BlobNotFoundError } from '../../src/errors.js';
import { toKey, toBlob } from '../../src/types.js';

const key = (s: string) => toKey(s);
const blob = (s: string) => toBlob(s);

describe('MemoryStorageAdapter', () => {
  test('persistBlob then readBlob returns same value', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.persistBlob(key('k1'), blob('hello'));
    expect(await adapter.readBlob(key('k1'))).toBe(blob('hello'));
  });

  test('readBlob throws BlobNotFoundError for missing key', async () => {
    const adapter = new MemoryStorageAdapter();
    await expect(adapter.readBlob(key('missing'))).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  test('BlobNotFoundError has correct key', async () => {
    const adapter = new MemoryStorageAdapter();
    try {
      await adapter.readBlob(key('abc'));
    } catch (e) {
      expect((e as BlobNotFoundError).key).toBe('abc');
    }
  });

  test('deleteBlob removes the entry', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.persistBlob(key('k1'), blob('v1'));
    await adapter.deleteBlob(key('k1'));
    await expect(adapter.readBlob(key('k1'))).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  test('deleteBlob is a no-op for missing key', async () => {
    const adapter = new MemoryStorageAdapter();
    await expect(adapter.deleteBlob(key('missing'))).resolves.toBeUndefined();
  });

  test('persistBlob is idempotent', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.persistBlob(key('k'), blob('first'));
    await adapter.persistBlob(key('k'), blob('first'));
    expect(await adapter.readBlob(key('k'))).toBe(blob('first'));
  });

  test('persistBlob overwrites on same key with new value', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.persistBlob(key('k'), blob('first'));
    await adapter.persistBlob(key('k'), blob('second'));
    expect(await adapter.readBlob(key('k'))).toBe(blob('second'));
  });

  test('readBlobs returns only keys that exist', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.persistBlob(key('a'), blob('1'));
    await adapter.persistBlob(key('b'), blob('2'));

    const result = await adapter.readBlobs!([key('a'), key('missing'), key('b')]);
    expect(result.size).toBe(2);
    expect(result.get(key('a'))).toBe(blob('1'));
    expect(result.get(key('b'))).toBe(blob('2'));
    expect(result.has(key('missing'))).toBe(false);
  });

  test('readBlobs on empty store returns empty map', async () => {
    const adapter = new MemoryStorageAdapter();
    const result = await adapter.readBlobs!([key('x'), key('y')]);
    expect(result.size).toBe(0);
  });

  test('size reflects current count', async () => {
    const adapter = new MemoryStorageAdapter();
    expect(adapter.size).toBe(0);
    await adapter.persistBlob(key('a'), blob('1'));
    await adapter.persistBlob(key('b'), blob('2'));
    expect(adapter.size).toBe(2);
    await adapter.deleteBlob(key('a'));
    expect(adapter.size).toBe(1);
  });
});
