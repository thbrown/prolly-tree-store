import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  ContentHash,
  JSONPatchDocument,
  JSONPointer,
  LeafNode,
  InternalNode,
} from './types.js';
import {
  decodeRootPointer,
  encodeNode,
  nodeBytesToBlob,
  encodeRootPointer,
} from './serialization.js';
import { chunkHashOf, entryHashOf, entryHashToContentHash, toHex, hexToBytes } from './hashing.js';
import * as jsonpatch from 'fast-json-patch';
import { rootKey, chunkKey, fetchNode, newNodeCache } from './tree-utils.js';
import type { NodeCache } from './tree-utils.js';
import { treeReader } from './prefix-scan.js';
import { PendingState, applyOps } from './patch-overlay.js';
import type { KeyMutation } from './patch-overlay.js';

// ─── Routing mutations to children ────────────────────────────────────────────

function childIndexForKey(node: InternalNode, key: string): number {
  for (let i = node.keys.length - 1; i >= 0; i--) {
    if (key >= node.keys[i]) return i + 1;
  }
  return 0;
}

function distributeToChildren(
  node: InternalNode,
  mutations: KeyMutation[]
): Map<number, KeyMutation[]> {
  const map = new Map<number, KeyMutation[]>();
  for (const m of mutations) {
    const idx = childIndexForKey(node, m.key);
    if (!map.has(idx)) map.set(idx, []);
    map.get(idx)!.push(m);
  }
  return map;
}

// ─── Core incremental tree update ────────────────────────────────────────────

interface MutationResult {
  chunkHash: Uint8Array;
  entryHash: Uint8Array;
  oldEntryHash: Uint8Array;
}

/** True if every byte of a 32-byte hash is zero. */
function isZeroHash(hash: Uint8Array): boolean {
  for (let i = 0; i < hash.length; i++) if (hash[i] !== 0) return false;
  return true;
}

/**
 * Nodes written and nodes made unreachable by a mutation walk.
 *
 * `retained` holds the children of visited internal nodes that the walk did not
 * descend into. Those subtrees are unchanged and still referenced, and their
 * hashes are known from the parent node that was already fetched — so deciding
 * what is safe to delete costs no extra reads.
 */
interface WalkOutcome {
  newNodes: Map<string, Uint8Array>;
  replacedHexes: Set<string>;
  retainedHexes: Set<string>;
}

/**
 * Apply `mutations` to the subtree rooted at `nodeHash`.
 *
 * New nodes are collected in `out.newNodes`. Replaced node hashes go to
 * `out.replacedHexes` so the caller can delete the orphaned blobs after
 * committing the new root pointer.
 *
 * A node is only a deletion candidate if its hash cannot appear elsewhere in the
 * tree. Within one document every node covers a distinct key range, and a node's
 * encoded bytes include its keys, so two nodes cannot share a hash — with one
 * exception: nodes that cover no entries at all (an emptied leaf, or an internal
 * node over emptied leaves) have no keys to tell them apart. Those are
 * identified by an all-zero entryHash and are never deleted; they are a handful
 * of bytes each, and the next `put` reclaims them.
 */
async function applyMutationBatch(
  nodeHash: Uint8Array,
  mutations: KeyMutation[],
  docKey: KeyString,
  adapter: StorageAdapter,
  out: WalkOutcome,
  cache: NodeCache
): Promise<MutationResult> {
  const node = await fetchNode(nodeHash, docKey, adapter, cache);
  const oldEntryHash = new Uint8Array(node.entryHash);

  if (!isZeroHash(oldEntryHash)) out.replacedHexes.add(toHex(nodeHash));

  // ── Leaf ──────────────────────────────────────────────────────────────────
  if (node.type === 0x02) {
    const leaf = node as LeafNode;
    const entries = new Map(leaf.entries.map(e => [e.key, e.valueMsgpack]));

    for (const m of mutations) {
      if (m.op === 'del') entries.delete(m.key);
      else entries.set(m.key, m.valueMsgpack);
    }

    const sortedEntries = [...entries.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, valueMsgpack]) => ({ key, valueMsgpack }));

    const entryHash = entryHashOf(sortedEntries);
    const newLeaf = {
      type: 0x02 as const,
      chunkHash: new Uint8Array(32),
      entryHash,
      entries: sortedEntries,
    };
    const bytes = encodeNode(newLeaf);
    const chunkHashHex = chunkHashOf(bytes) as string;
    const chunkHash = hexToBytes(chunkHashHex);

    out.newNodes.set(chunkHashHex, bytes);
    return { chunkHash, entryHash, oldEntryHash };
  }

  // ── Internal node ─────────────────────────────────────────────────────────
  const internal = node as InternalNode;
  const childMutMap = distributeToChildren(internal, mutations);

  // Siblings the walk will not descend into keep their subtrees intact.
  for (let i = 0; i < internal.children.length; i++) {
    if (!childMutMap.has(i)) out.retainedHexes.add(toHex(internal.children[i]));
  }

  const childResults = await Promise.all(
    [...childMutMap.entries()].map(async ([childIdx, childMuts]) => {
      const result = await applyMutationBatch(
        internal.children[childIdx], childMuts, docKey, adapter, out, cache
      );
      return { childIdx, result };
    })
  );

  const newChildren = [...internal.children];
  const newEntryHash = new Uint8Array(internal.entryHash);

  for (const { childIdx, result } of childResults) {
    newChildren[childIdx] = result.chunkHash;
    for (let j = 0; j < 32; j++) {
      newEntryHash[j] ^= result.oldEntryHash[j] ^ result.entryHash[j];
    }
  }

  const newInternal: InternalNode = {
    type: 0x01,
    chunkHash: new Uint8Array(32),
    entryHash: newEntryHash,
    level: internal.level,
    keys: internal.keys,
    children: newChildren,
  };
  const bytes = encodeNode(newInternal);
  const chunkHashHex = chunkHashOf(bytes) as string;
  newInternal.chunkHash = hexToBytes(chunkHashHex);

  out.newNodes.set(chunkHashHex, bytes);
  return { chunkHash: newInternal.chunkHash, entryHash: newEntryHash, oldEntryHash };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply an RFC 6902 patch to a stored document without loading the full document.
 *
 * Operations are planned in order against an overlay of pending entry changes
 * (see ./patch-overlay.ts), so each op sees the result of the ones before it, as
 * RFC 6902 requires. Nothing is written until the whole list has been planned:
 * if any op is rejected — a failing `test`, an out-of-range array index, an
 * unsupported op — the stored document is left untouched.
 *
 * Replaced nodes are deleted after the new root pointer is committed, keeping
 * storage bounded with no separate GC sweep required.
 */
export async function patch(
  key: KeyString,
  patches: JSONPatchDocument,
  adapter: StorageAdapter,
): Promise<ContentHash> {
  const ops: jsonpatch.Operation[] = JSON.parse(patches as string);

  const rootBlob = await adapter.readBlob(rootKey(key));
  const rootPtr = decodeRootPointer(rootBlob);

  if (ops.length === 0) return entryHashToContentHash(rootPtr.entryHash);

  const cache = newNodeCache();
  const state = new PendingState(treeReader(rootPtr.chunkHash, key, adapter, cache));
  await applyOps(ops, state);

  const mutations: KeyMutation[] = state.toMutations();
  if (mutations.length === 0) return entryHashToContentHash(rootPtr.entryHash);

  const out: WalkOutcome = {
    newNodes: new Map(),
    replacedHexes: new Set(),
    retainedHexes: new Set(),
  };
  const result = await applyMutationBatch(rootPtr.chunkHash, mutations, key, adapter, out, cache);

  // Write new nodes
  await Promise.all(
    [...out.newNodes.entries()].map(([hex, bytes]) =>
      adapter.persistBlob(chunkKey(key, hexToBytes(hex)), nodeBytesToBlob(bytes))
    )
  );

  // Commit new root pointer
  await adapter.persistBlob(rootKey(key), encodeRootPointer({
    format: rootPtr.format,
    chunkHash: result.chunkHash,
    entryHash: result.entryHash,
    chunkSize: rootPtr.chunkSize,
    calibratedAt: rootPtr.calibratedAt,
  }));

  // Delete the nodes the walk replaced, except any that the new tree still
  // points at: a node rewritten to identical bytes, or a retained sibling.
  // Both sets came from nodes already in hand, so this needs no further reads.
  await Promise.all(
    [...out.replacedHexes]
      .filter(hex => !out.newNodes.has(hex) && !out.retainedHexes.has(hex))
      .map(hex => adapter.deleteBlob(chunkKey(key, hexToBytes(hex))))
  );

  return entryHashToContentHash(result.entryHash);
}
