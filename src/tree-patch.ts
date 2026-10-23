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
import { entryHashToContentHash, toHex, hexToBytes } from './hashing.js';
import {
  groupLeafEntries,
  groupChildren,
  makeLeaf,
  makeInternal,
  childrenOf,
} from './prolly.js';
import type { Child, BuiltNode } from './prolly.js';
import * as jsonpatch from 'fast-json-patch';
import { rootKey, chunkKey, fetchNode, newNodeCache } from './tree-utils.js';
import type { NodeCache } from './tree-utils.js';
import { treeReader } from './prefix-scan.js';
import { PendingState, applyOps } from './patch-overlay.js';
import type { KeyMutation } from './patch-overlay.js';

// ─── Routing mutations to children ────────────────────────────────────────────

/**
 * Index of the child covering `key`.
 *
 * `keys[i]` is the last key child `i` holds, so the first child whose last key
 * is not below `key` owns it. A key past the final child's range belongs to that
 * child, which is where an append lands.
 */
function childIndexForKey(node: InternalNode, key: string): number {
  for (let i = 0; i < node.keys.length; i++) {
    if (key <= node.keys[i]) return i;
  }
  return node.keys.length - 1;
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

/** What a mutated subtree becomes, in its parent's terms. */
interface Replacement {
  /**
   * The nodes that now stand where the old node stood. Empty when every entry
   * beneath it was removed, which is how emptied nodes are merged away rather
   * than left behind; more than one when the node was split.
   */
  children: Child[];
  /** Level of the produced nodes: 0 for leaves, otherwise the internal level. */
  level: number;
  /** entryHash of the node being replaced, for the caller's XOR bookkeeping. */
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

function record(built: BuiltNode, out: WalkOutcome): Child {
  out.newNodes.set(toHex(built.child.chunkHash), built.bytes);
  return built.child;
}

/**
 * Apply `mutations` to the subtree rooted at `nodeHash`, re-chunking as it goes.
 *
 * Mutated nodes are rebuilt and regrouped at the same content-defined boundaries
 * `put` uses, so a leaf that grew past its boundary splits and a leaf that lost
 * all its entries disappears. Splitting and dropping are both local: an internal
 * node records each child's entryHash and first key, so a new node's entryHash
 * is the XOR of the children it ends up with and no sibling is ever fetched.
 *
 * A node is only a deletion candidate if its hash cannot appear elsewhere in the
 * tree. Within one document every node covers a distinct key range, and a node's
 * encoded bytes include its keys, so two nodes cannot share a hash — except a
 * node covering no entries at all, which has no keys to tell it apart. Those are
 * identified by an all-zero entryHash and are never deleted; the only one that
 * can exist is the empty root, and `gc()` reclaims any stragglers.
 */
async function applyMutationBatch(
  nodeHash: Uint8Array,
  mutations: KeyMutation[],
  docKey: KeyString,
  adapter: StorageAdapter,
  out: WalkOutcome,
  cache: NodeCache,
  chunkSize: number
): Promise<Replacement> {
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

    if (entries.size === 0) return { children: [], level: 0, oldEntryHash };

    const sorted = [...entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, valueMsgpack]) => ({ key, valueMsgpack }));

    const children = groupLeafEntries(sorted, chunkSize).map(group =>
      record(makeLeaf(group), out)
    );

    return { children, level: 0, oldEntryHash };
  }

  // ── Internal node ─────────────────────────────────────────────────────────
  const internal = node as InternalNode;
  const childMutMap = distributeToChildren(internal, mutations);
  const oldChildren = childrenOf(internal);

  // Siblings the walk will not descend into keep their subtrees intact.
  for (let i = 0; i < oldChildren.length; i++) {
    if (!childMutMap.has(i)) out.retainedHexes.add(toHex(oldChildren[i].chunkHash));
  }

  const results = new Map<number, Replacement>();
  await Promise.all(
    [...childMutMap.entries()].map(async ([childIdx, childMuts]) => {
      results.set(
        childIdx,
        await applyMutationBatch(
          oldChildren[childIdx].chunkHash, childMuts, docKey, adapter, out, cache, chunkSize
        )
      );
    })
  );

  // Splice each mutated child's replacement into the child list in place.
  const newChildren: Child[] = [];
  for (let i = 0; i < oldChildren.length; i++) {
    const replaced = results.get(i);
    if (replaced) newChildren.push(...replaced.children);
    else newChildren.push(oldChildren[i]);
  }

  if (newChildren.length === 0) {
    return { children: [], level: internal.level, oldEntryHash };
  }

  // Regroup at this level so a node that gained children splits rather than
  // growing without bound.
  const children = groupChildren(newChildren, internal.level, chunkSize).map(group =>
    record(makeInternal(group, internal.level), out)
  );

  return { children, level: internal.level, oldEntryHash };
}

/**
 * Reduce a replaced root to a single node, adding levels when it split and
 * falling back to an empty leaf when the document lost every entry.
 */
function buildNewRoot(
  replacement: Replacement,
  chunkSize: number,
  out: WalkOutcome
): Child {
  if (replacement.children.length === 0) return record(makeLeaf([]), out);

  let children = replacement.children;
  let level = replacement.level + 1;

  while (children.length > 1) {
    children = groupChildren(children, level, chunkSize).map(group =>
      record(makeInternal(group, level), out)
    );
    level++;
  }


  return children[0];
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
  retainStaleChunks = false
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
  const replacement = await applyMutationBatch(
    rootPtr.chunkHash, mutations, key, adapter, out, cache, rootPtr.chunkSize
  );
  const result = buildNewRoot(replacement, rootPtr.chunkSize, out);

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
  //
  // `retainStaleChunks` defers this to `gc(key)`, for the same reasons it does
  // on `put`: a concurrent reader holding the previous root hash, or another
  // document sharing these chunks, still needs them.
  if (!retainStaleChunks) {
    await Promise.all(
      [...out.replacedHexes]
        .filter(hex => !out.newNodes.has(hex) && !out.retainedHexes.has(hex))
        .map(hex => adapter.deleteBlob(chunkKey(key, hexToBytes(hex))))
    );
  }

  return entryHashToContentHash(result.entryHash);
}
