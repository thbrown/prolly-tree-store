import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  ContentHash,
  PartitionerState,
  RootPointer,
  InternalNode,
} from './types.js';
import { DEFAULT_CHUNK_SIZE } from './types.js';
import { flattenDocument } from './encoding.js';
import { buildTree } from './prolly.js';
import { encodeRootPointer, nodeBytesToBlob, decodeRootPointer, decodeNode, blobToNodeBytes } from './serialization.js';
import { entryHashToContentHash, toHex, hexToBytes } from './hashing.js';
import { rootKey, chunkKey } from './tree-utils.js';

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
  state?: Partial<PartitionerState>
): Promise<ContentHash> {
  const chunkSize = state?.chunkSize ?? DEFAULT_CHUNK_SIZE;

  // Collect old chunk hashes before overwriting (for cleanup after commit)
  const oldChunkHexes = new Set<string>();
  try {
    const oldRootBlob = await adapter.readBlob(rootKey(key));
    const oldRootPtr = decodeRootPointer(oldRootBlob);
    await collectAllChunkHexes(oldRootPtr.chunkHash, key, adapter, oldChunkHexes);
  } catch {
    // No existing document — nothing to clean up
  }

  // Flatten the document into sorted (treeKey → JSONValue) entries
  const flatMap = flattenDocument(value);
  const entries = [...flatMap.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) as [string, JSONValue][];

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

