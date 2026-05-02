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
import { PatchTestFailedError } from './errors.js';
import {
  decodeRootPointer,
  decodeNode,
  encodeNode,
  blobToNodeBytes,
  nodeBytesToBlob,
  encodeRootPointer,
  encodeValue,
} from './serialization.js';
import { chunkHashOf, entryHashOf, entryHashToContentHash, toHex, hexToBytes } from './hashing.js';
import { pointerToTreeKey, flattenDocument } from './encoding.js';
import { toPointer } from './types.js';
import { get } from './tree-read.js';
import * as jsonpatch from 'fast-json-patch';
import { rootKey, chunkKey, fetchNode } from './tree-utils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Key-level mutation types ─────────────────────────────────────────────────

type KeyMutation =
  | { key: string; op: 'set'; valueMsgpack: Uint8Array }
  | { key: string; op: 'del' };

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

// ─── Partial entry collection ─────────────────────────────────────────────────

async function collectEntriesUnderPrefix(
  nodeHash: Uint8Array,
  prefix: string,
  docKey: KeyString,
  adapter: StorageAdapter
): Promise<Array<{ key: string; valueMsgpack: Uint8Array }>> {
  const node = await fetchNode(nodeHash, docKey, adapter);

  if (node.type === 0x02) {
    const leaf = node as LeafNode;
    return leaf.entries.filter(
      e => prefix === '' || e.key === prefix || e.key.startsWith(prefix + '\x00')
    );
  }

  const internal = node as InternalNode;
  const results: Array<{ key: string; valueMsgpack: Uint8Array }> = [];

  for (let i = 0; i < internal.children.length; i++) {
    const lo = i === 0 ? '' : internal.keys[i - 1];
    const hi = i < internal.keys.length ? internal.keys[i] : null;
    const loOk = lo === '' || lo <= prefix || lo.startsWith(prefix) || prefix.startsWith(lo) || prefix >= lo;
    const hiOk = hi === null || hi > prefix;
    if (loOk && hiOk) {
      const sub = await collectEntriesUnderPrefix(internal.children[i], prefix, docKey, adapter);
      results.push(...sub);
    }
  }

  return results;
}

// ─── Ops → flat key mutations ─────────────────────────────────────────────────

async function opsToMutations(
  ops: jsonpatch.Operation[],
  rootHash: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter
): Promise<KeyMutation[]> {
  const byKey = new Map<string, KeyMutation>();
  const apply = (m: KeyMutation) => byKey.set(m.key, m);

  for (const op of ops) {
    if (op.op === 'test') continue;

    const prefix = pointerToTreeKey(op.path as JSONPointer);

    if (op.op === 'remove' || op.op === 'replace' || op.op === 'add') {
      const old = await collectEntriesUnderPrefix(rootHash, prefix, docKey, adapter);
      for (const e of old) apply({ key: e.key, op: 'del' });
    }

    if (op.op === 'add' || op.op === 'replace') {
      const flat = flattenDocument((op as jsonpatch.AddOperation<JSONValue> | jsonpatch.ReplaceOperation<JSONValue>).value);
      for (const [suffix, value] of flat) {
        const key =
          prefix === '' ? suffix
          : suffix === '' ? prefix
          : `${prefix}\x00${suffix}`;
        apply({ key, op: 'set', valueMsgpack: encodeValue(value) });
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ─── Core incremental tree update ────────────────────────────────────────────

interface MutationResult {
  chunkHash: Uint8Array;
  entryHash: Uint8Array;
  oldEntryHash: Uint8Array;
}

/**
 * Apply `mutations` to the subtree rooted at `nodeHash`.
 *
 * New nodes are collected in `newNodes`. Replaced node hashes are collected
 * in `replacedHexes` so the caller can delete the now-orphaned blobs after
 * committing the new root pointer.
 */
async function applyMutationBatch(
  nodeHash: Uint8Array,
  mutations: KeyMutation[],
  docKey: KeyString,
  adapter: StorageAdapter,
  newNodes: Map<string, Uint8Array>,
  replacedHexes: Set<string>
): Promise<MutationResult> {
  const node = await fetchNode(nodeHash, docKey, adapter);
  const oldEntryHash = new Uint8Array(node.entryHash);

  // Track that this node is being replaced
  replacedHexes.add(toHex(nodeHash));

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

    newNodes.set(chunkHashHex, bytes);
    return { chunkHash, entryHash, oldEntryHash };
  }

  // ── Internal node ─────────────────────────────────────────────────────────
  const internal = node as InternalNode;
  const childMutMap = distributeToChildren(internal, mutations);

  const childResults = await Promise.all(
    [...childMutMap.entries()].map(async ([childIdx, childMuts]) => {
      const result = await applyMutationBatch(
        internal.children[childIdx], childMuts, docKey, adapter, newNodes, replacedHexes
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

  newNodes.set(chunkHashHex, bytes);
  return { chunkHash: newInternal.chunkHash, entryHash: newEntryHash, oldEntryHash };
}

// ─── New-tree reachability walk ───────────────────────────────────────────────

/**
 * Walk the new tree (root at `nodeHash`) and collect every reachable chunk hex.
 * Uses `newNodes` for newly-created nodes (in memory) and the adapter for
 * unchanged nodes, avoiding double-reads where possible.
 *
 * This is needed because `replacedHexes` may contain a hash that was visited
 * during mutation traversal but also appears as an UNCHANGED child elsewhere in
 * the new tree (e.g. two children with identical content sharing the same hash).
 * Simply checking `newNodes` misses those retained references.
 */
async function collectNewTreeHexes(
  nodeHash: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter,
  newNodes: Map<string, Uint8Array>,
  out: Set<string>
): Promise<void> {
  const hex = toHex(nodeHash);
  if (out.has(hex)) return;
  out.add(hex);

  let bytes: Uint8Array;
  if (newNodes.has(hex)) {
    bytes = newNodes.get(hex)!;
  } else {
    const blob = await adapter.readBlob(chunkKey(docKey, nodeHash));
    bytes = blobToNodeBytes(blob);
  }

  const node = decodeNode(bytes, nodeHash);
  if (node.type === 0x01) {
    await Promise.all(
      (node as InternalNode).children.map(ch =>
        collectNewTreeHexes(ch, docKey, adapter, newNodes, out)
      )
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply an RFC 6902 patch to a stored document without loading the full document.
 *
 * `test` ops are evaluated via partial reads before any mutation. If any test
 * fails the document is left unchanged and PatchTestFailedError is thrown.
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
  if (ops.length === 0) {
    const blob = await adapter.readBlob(rootKey(key));
    const rootPtr = decodeRootPointer(blob);
    return entryHashToContentHash(rootPtr.entryHash);
  }

  // Validate all test ops atomically via partial reads — no full-doc load
  for (const op of ops) {
    if (op.op !== 'test') continue;
    const actual = await get(key, adapter, op.path as JSONPointer);
    const expected = (op as jsonpatch.TestOperation<JSONValue>).value;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new PatchTestFailedError(toPointer(op.path), expected as JSONValue, actual);
    }
  }

  const rootBlob = await adapter.readBlob(rootKey(key));
  const rootPtr = decodeRootPointer(rootBlob);

  const mutations = await opsToMutations(ops, rootPtr.chunkHash, key, adapter);
  if (mutations.length === 0) return entryHashToContentHash(rootPtr.entryHash);

  const newNodes = new Map<string, Uint8Array>();
  const replacedHexes = new Set<string>();
  const result = await applyMutationBatch(
    rootPtr.chunkHash, mutations, key, adapter, newNodes, replacedHexes
  );

  // Write new nodes
  await Promise.all(
    [...newNodes.entries()].map(([hex, bytes]) =>
      adapter.persistBlob(chunkKey(key, hexToBytes(hex)), nodeBytesToBlob(bytes))
    )
  );

  // Commit new root pointer
  await adapter.persistBlob(rootKey(key), encodeRootPointer({
    chunkHash: result.chunkHash,
    entryHash: result.entryHash,
    chunkSize: rootPtr.chunkSize,
    calibratedAt: rootPtr.calibratedAt,
  }));

  // Collect ALL hashes reachable from the new root before deleting anything.
  // This prevents deleting a hash that appears multiple times in the old tree
  // (e.g. two children with identical content): the visited copy is in
  // replacedHexes, but the untouched copy is still referenced by the new tree.
  const allNewTreeHexes = new Set<string>();
  await collectNewTreeHexes(result.chunkHash, key, adapter, newNodes, allNewTreeHexes);

  await Promise.all(
    [...replacedHexes]
      .filter(hex => !allNewTreeHexes.has(hex))
      .map(hex => adapter.deleteBlob(chunkKey(key, hexToBytes(hex))))
  );

  return entryHashToContentHash(result.entryHash);
}
