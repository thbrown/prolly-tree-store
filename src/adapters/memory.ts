import type { StorageAdapter, KeyString, JSONBlob } from '../types.js';
import { BlobNotFoundError } from '../errors.js';

/**
 * In-process Map-backed StorageAdapter.
 * Used as the reference implementation and in all unit/integration tests.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>();

  async persistBlob(key: KeyString, value: JSONBlob): Promise<void> {
    this.store.set(key as string, value as string);
  }

  async readBlob(key: KeyString): Promise<JSONBlob> {
    const value = this.store.get(key as string);
    if (value === undefined) throw new BlobNotFoundError(key);
    return value as JSONBlob;
  }

  async deleteBlob(key: KeyString): Promise<void> {
    this.store.delete(key as string);
  }

  async readBlobs(keys: KeyString[]): Promise<Map<KeyString, JSONBlob>> {
    const result = new Map<KeyString, JSONBlob>();
    for (const key of keys) {
      const value = this.store.get(key as string);
      if (value !== undefined) result.set(key, value as JSONBlob);
    }
    return result;
  }

  /** Number of blobs currently in the store. Useful in tests. */
  get size(): number {
    return this.store.size;
  }

  /** All keys currently in the store. Useful in tests. */
  keys(): string[] {
    return [...this.store.keys()];
  }
}
