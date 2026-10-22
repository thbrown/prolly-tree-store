import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  ContentHash,
  PartitionerState,
  RootPointer,
  InternalNode,
} from './types.js';
import { DEFAULT_CHUNK_SIZE, FORMAT_VERSION } from './types.js';
import { flattenDocument } from './encoding.js';
import { buildTree } from './prolly.js';
import { encodeRootPointer, nodeBytesToBlob, decodeRootPointer, decodeNode, blobToNodeBytes } from './serialization.js';
import { entryHashToContentHash, toHex, hexToBytes } from './hashing.js';
import { rootKey, chunkKey, chunkPrefix } from './tree-utils.js';

/**
 * Walk the tree rooted at `nodeHash` and collect every chunk hex hash into `out`.
 * Used to find the full set of blobs owned by a document before cleanup.
 */
async function collectAllChunkHexes(
  nodeHash: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter,
  out: Set<string>
): Promise<void> {
  const hex = toHex(nodeHash);
  if (out.has(hex)) return;
  out.add(hex);

  const blob = await adapter.readBlob(chunkKey(docKey, nodeHash));
  const node = decodeNode(blobToNodeBytes(blob), nodeHash);

  if (node.type === 0x01) {
    await Promise.all(
      (node as InternalNode).children.map(ch => collectAllChunkHexes(ch, docKey, adapter, out))
    );
  }
}

/**
 * Store a full document at `key`, replacing any existing value.
 * Returns the new entry hash (chunk-size independent fingerprint).
 *
 * Chunks are namespaced under `chunks/{key}/` so they are exclusively owned
 * by this document. Stale chunks from the previous version are deleted after
 * the new root pointer is committed.
 */
export async function put(
  key: KeyString,
  value: JSONValue,
  adapter: StorageAdapter,
  state?: Partial<PartitionerState>,
  retainStaleChunks = false
): Promise<ContentHash> {
  const chunkSize = state?.chunkSize ?? DEFAULT_CHUNK_SIZE;

  // Collect old chunk hashes before overwriting (for cleanup after commit).
  // Skipped entirely when stale chunks are retained — walking the old tree is
  // O(n) reads, and there is nothing to do with the result.
  const oldChunkHexes = new Set<string>();
  if (!retainStaleChunks) {
    try {
      const oldRootBlob = await adapter.readBlob(rootKey(key));
      const oldRootPtr = decodeRootPointer(oldRootBlob);
      await collectAllChunkHexes(oldRootPtr.chunkHash, key, adapter, oldChunkHexes);
    } catch {
      // No existing document — nothing to clean up
    }
  }

  // Flatten the document into sorted (treeKey → StoredValue) entries
  const flatMap = flattenDocument(value);
  const entries = [...flatMap.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  // Build the Prolly tree
  const { root, rootBytes, allNodes } = buildTree(entries, chunkSize);

  // Dedup: only write nodes that don't already exist in the adapter
  const chunkEntries = [...allNodes.entries()].map(([hex, bytes]) => ({
    key: chunkKey(key, hexToBytes(hex)),
    hex,
    blob: nodeBytesToBlob(bytes),
  }));

  const existing = adapter.readBlobs
    ? await adapter.readBlobs(chunkEntries.map(e => e.key))
    : new Map();

  await Promise.all(
    chunkEntries
      .filter(e => !existing.has(e.key))
      .map(e => adapter.persistBlob(e.key, e.blob))
  );

  // Write the root pointer
  const rootPointer: RootPointer = {
    format: FORMAT_VERSION,
    chunkHash: root.chunkHash,
    entryHash: root.entryHash,
    chunkSize,
    calibratedAt: Date.now(),
  };
  await adapter.persistBlob(rootKey(key), encodeRootPointer(rootPointer));

  // Delete chunks that belonged to the old tree but not the new one
  const newChunkHexes = new Set(allNodes.keys());
  await Promise.all(
    [...oldChunkHexes]
      .filter(hex => !newChunkHexes.has(hex))
      .map(hex => adapter.deleteBlob(chunkKey(key, hexToBytes(hex))))
  );

  return entryHashToContentHash(root.entryHash);
}

/**
 * Reclaim chunk blobs under `key` that the current tree no longer references.
 *
 * Needed because a crash between writing chunks and committing the root pointer
 * leaves the written chunks behind, and because `retainStaleChunks` defers
 * reclamation on purpose. Requires `listBlobs` on the adapter: orphans are by
 * definition unreachable from the root, so there is no other way to find them.
 *
 * Returns the number of blobs deleted.
 */
export async function gc(key: KeyString, adapter: StorageAdapter): Promise<number> {
  if (!adapter.listBlobs) {
    throw new Error(
      'gc() requires the storage adapter to implement listBlobs(prefix)'
    );
  }

  const prefix = chunkPrefix(key);
  const stored = await adapter.listBlobs(prefix);

  let rootPtr: RootPointer;
  try {
    rootPtr = decodeRootPointer(await adapter.readBlob(rootKey(key)));
  } catch {
    // No document: every chunk under the prefix is unreachable.
    await Promise.all(stored.map(blobKey => adapter.deleteBlob(blobKey)));
    return stored.length;
  }

  const reachable = new Set<string>();
  await collectAllChunkHexes(rootPtr.chunkHash, key, adapter, reachable);

  const reachableKeys = new Set(
    [...reachable].map(hex => chunkKey(key, hexToBytes(hex)) as string)
  );
  const orphans = stored.filter(blobKey => !reachableKeys.has(blobKey as string));

  await Promise.all(orphans.map(blobKey => adapter.deleteBlob(blobKey)));
  return orphans.length;
}

/**
 * Delete a document and all of its chunk blobs.
 *
 * Chunks are scoped to this document's key prefix, so deletion is always
 * safe — no other document can reference them.
 * No-ops silently if the document does not exist.
 */
export async function remove(
  key: KeyString,
  adapter: StorageAdapter
): Promise<void> {
  const rKey = rootKey(key);
  let rootPtr: RootPointer;
  try {
    rootPtr = decodeRootPointer(await adapter.readBlob(rKey));
  } catch {
    return; // Key doesn't exist — no-op
  }

  // Walk the tree to collect all chunk hashes
  const chunkHexes = new Set<string>();
  await collectAllChunkHexes(rootPtr.chunkHash, key, adapter, chunkHexes);

  // Delete all chunk blobs then the root pointer
  await Promise.all([
    ...[...chunkHexes].map(hex => adapter.deleteBlob(chunkKey(key, hexToBytes(hex)))),
    adapter.deleteBlob(rKey),
  ]);
}

