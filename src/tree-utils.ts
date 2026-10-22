import type { StorageAdapter, KeyString, TreeNode } from './types.js';
import { ROOT_PREFIX, CHUNK_PREFIX, toKey } from './types.js';
import { toHex } from './hashing.js';
import { decodeNode, blobToNodeBytes } from './serialization.js';

export { toHex };
export { hexToBytes } from './hashing.js';

export function rootKey(docKey: KeyString): KeyString {
  return toKey(ROOT_PREFIX + (docKey as string));
}

/** Key prefix under which all of a document's chunk blobs live. */
export function chunkPrefix(docKey: KeyString): string {
  return `${CHUNK_PREFIX}${docKey as string}/`;
}

export function chunkKey(docKey: KeyString, chunkHashBytes: Uint8Array): KeyString {
  const hex = toHex(chunkHashBytes);
  return toKey(`${chunkPrefix(docKey)}${hex.slice(0, 2)}/${hex}`);
}

/**
 * Per-operation cache of decoded nodes, keyed by hex chunk hash.
 *
 * A single `get` or `patch` walks the tree several times — resolving the
 * pointer, reading the target subtree, then rewriting the path — and those walks
 * share every node above the leaf. Nodes are content-addressed and immutable, so
 * caching them for the duration of one operation is always safe, and it turns
 * repeated walks into one read per node. Callers must not mutate what they get
 * back; the read paths all copy before changing anything.
 */
export type NodeCache = Map<string, TreeNode>;

export const newNodeCache = (): NodeCache => new Map();

export async function fetchNode(
  chunkHashBytes: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter,
  cache?: NodeCache
): Promise<TreeNode> {
  const hex = cache ? toHex(chunkHashBytes) : '';
  if (cache) {
    const hit = cache.get(hex);
    if (hit) return hit;
  }

  const blob = await adapter.readBlob(chunkKey(docKey, chunkHashBytes));
  const node = decodeNode(blobToNodeBytes(blob), chunkHashBytes);
  if (cache) cache.set(hex, node);
  return node;
}
