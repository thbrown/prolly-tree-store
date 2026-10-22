import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  StoredValue,
  ContentHash,
  RootPointer,
  JSONPointer,
} from './types.js';
import { toKey } from './types.js';
import { BlobNotFoundError } from './errors.js';
import { decodeRootPointer, decodeValue } from './serialization.js';
import { entryHashToContentHash } from './hashing.js';
import { unflattenEntries, relativeKey } from './encoding.js';
import { resolvePointer } from './pointer.js';
import { treeReader, scanPrefix } from './prefix-scan.js';
import { rootKey } from './tree-utils.js';

async function fetchRootPointer(
  key: KeyString,
  adapter: StorageAdapter
): Promise<RootPointer> {
  const blob = await adapter.readBlob(rootKey(key));
  return decodeRootPointer(blob);
}

/**
 * Return the entry-hash (chunk-size-independent fingerprint) of the document at `key`.
 * Only fetches the root pointer blob — never fetches leaf or internal nodes.
 */
export async function getRootHash(
  key: KeyString,
  adapter: StorageAdapter
): Promise<ContentHash> {
  const root = await fetchRootPointer(key, adapter);
  return entryHashToContentHash(root.entryHash);
}

/**
 * Rebuild the JSON value stored at `treeKey`, or undefined if nothing is there.
 * Fetches only the nodes covering that key's subtree.
 */
export async function readSubtree(
  rootHash: Uint8Array,
  treeKey: string,
  docKey: KeyString,
  adapter: StorageAdapter
): Promise<JSONValue | undefined> {
  const entries = await scanPrefix(rootHash, treeKey, docKey, adapter);
  if (entries.length === 0) return undefined;

  return unflattenEntries(
    entries.map(
      e => [relativeKey(e.key, treeKey), decodeValue(e.valueMsgpack)] as [string, StoredValue]
    )
  );
}

/**
 * Retrieve a full document or the sub-value at `pointer`.
 *
 * Without `pointer` (or with an empty one): returns the entire stored document.
 * With `pointer`: resolves it against the stored container shapes (so a numeric
 * segment indexes an array only where an array is actually stored) and walks
 * only the subtree covering that key.
 */
export async function get(
  key: KeyString,
  adapter: StorageAdapter,
  pointer?: JSONPointer
): Promise<JSONValue> {
  const rootPtr = await fetchRootPointer(key, adapter);

  if (pointer === undefined || (pointer as string) === '') {
    const value = await readSubtree(rootPtr.chunkHash, '', key, adapter);
    return value === undefined ? {} : value;
  }

  const reader = treeReader(rootPtr.chunkHash, key, adapter);
  const resolved = await resolvePointer(pointer, reader);

  const value = await readSubtree(rootPtr.chunkHash, resolved.treeKey, key, adapter);
  if (value === undefined) {
    throw new BlobNotFoundError(toKey(`${key as string}${pointer as string}`));
  }
  return value;
}
