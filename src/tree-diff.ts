import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  StoredValue,
  JSONPatchDocument,
  LeafNode,
  InternalNode,
} from './types.js';
import { toPatch } from './types.js';
import { decodeRootPointer, decodeValue } from './serialization.js';
import { unflattenEntries, treeKeyToPointer, isUnderPrefix, relativeKey } from './encoding.js';
import * as jsonpatch from 'fast-json-patch';
import { rootKey, fetchNode } from './tree-utils.js';
import { existsPrefix, kindOf } from './prefix-scan.js';
import { readSubtree } from './tree-read.js';

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Entry collection helpers ────────────────────────────────────────────────

async function collectAllLeafEntries(
  chunkHashBytes: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter
): Promise<Map<string, Uint8Array>> {
  const node = await fetchNode(chunkHashBytes, docKey, adapter);
  if (node.type === 0x02) {
    const leaf = node as LeafNode;
    return new Map(leaf.entries.map(e => [e.key, e.valueMsgpack]));
  }
  const internal = node as InternalNode;
  const childMaps = await Promise.all(
    internal.children.map(ch => collectAllLeafEntries(ch, docKey, adapter))
  );
  const result = new Map<string, Uint8Array>();
  for (const m of childMaps) for (const [k, v] of m) result.set(k, v);
  return result;
}

// ─── Entry-level change collection ───────────────────────────────────────────

interface EntryChanges {
  added: Map<string, StoredValue>;
  removed: Set<string>;
  modified: Map<string, StoredValue>;
}

/**
 * Walk both trees in lockstep using chunkHash pruning.
 * Uses `keyA` to fetch nodes from tree A and `keyB` for tree B.
 */
async function walkChanges(
  hashA: Uint8Array,
  hashB: Uint8Array,
  keyA: KeyString,
  keyB: KeyString,
  adapter: StorageAdapter,
  result: EntryChanges
): Promise<void> {
  if (arraysEqual(hashA, hashB)) return;

  const [nodeA, nodeB] = await Promise.all([
    fetchNode(hashA, keyA, adapter),
    fetchNode(hashB, keyB, adapter),
  ]);

  if (nodeA.type === 0x02 && nodeB.type === 0x02) {
    diffLeafNodes(nodeA as LeafNode, nodeB as LeafNode, result);
    return;
  }

  if (nodeA.type === 0x01 && nodeB.type === 0x01) {
    await diffInternalNodes(nodeA as InternalNode, nodeB as InternalNode, keyA, keyB, adapter, result);
    return;
  }

  // Mixed levels — collect everything from both sides
  const [entriesA, entriesB] = await Promise.all([
    collectAllLeafEntries(hashA, keyA, adapter),
    collectAllLeafEntries(hashB, keyB, adapter),
  ]);
  mergeEntryMaps(entriesA, entriesB, result);
}

function diffLeafNodes(leafA: LeafNode, leafB: LeafNode, result: EntryChanges): void {
  const mapA = new Map(leafA.entries.map(e => [e.key, e.valueMsgpack]));
  const mapB = new Map(leafB.entries.map(e => [e.key, e.valueMsgpack]));

  for (const [key, vbytes] of mapB) {
    const abytes = mapA.get(key);
    if (!abytes) {
      result.added.set(key, decodeValue(vbytes));
    } else if (!arraysEqual(abytes, vbytes)) {
      result.modified.set(key, decodeValue(vbytes));
    }
  }
  for (const key of mapA.keys()) {
    if (!mapB.has(key)) result.removed.add(key);
  }
}

function mergeEntryMaps(
  entriesA: Map<string, Uint8Array>,
  entriesB: Map<string, Uint8Array>,
  result: EntryChanges
): void {
  for (const [key, vb] of entriesB) {
    const va = entriesA.get(key);
    if (va === undefined) {
      result.added.set(key, decodeValue(vb));
    } else if (!arraysEqual(va, vb)) {
      result.modified.set(key, decodeValue(vb));
    }
  }
  for (const key of entriesA.keys()) {
    if (!entriesB.has(key)) result.removed.add(key);
  }
}

/**
 * Compare two internal nodes' children, recursing only into changed pairs.
 *
 * When separator keys match exactly, children align 1-1 — O(changed nodes).
 * When they differ (different tree structures), falls back to full entry
 * collection — O(n) but always correct.
 */
async function diffInternalNodes(
  nodeA: InternalNode,
  nodeB: InternalNode,
  keyA: KeyString,
  keyB: KeyString,
  adapter: StorageAdapter,
  result: EntryChanges
): Promise<void> {
  const sameStructure =
    nodeA.keys.length === nodeB.keys.length &&
    nodeA.keys.every((k, i) => k === nodeB.keys[i]);

  if (sameStructure) {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < nodeA.children.length; i++) {
      if (!arraysEqual(nodeA.children[i], nodeB.children[i])) {
        tasks.push(walkChanges(nodeA.children[i], nodeB.children[i], keyA, keyB, adapter, result));
      }
    }
    await Promise.all(tasks);
  } else {
    const [entriesA, entriesB] = await Promise.all([
      collectAllLeafEntries(nodeA.chunkHash, keyA, adapter),
      collectAllLeafEntries(nodeB.chunkHash, keyB, adapter),
    ]);
    mergeEntryMaps(entriesA, entriesB, result);
  }
}

// ─── Kind-change detection ────────────────────────────────────────────────────

/**
 * The shallowest paths at which the two documents disagree about the kind of
 * value stored, considering every changed key and its ancestors.
 *
 * A path where one side is absent is left alone: that is an ordinary add or
 * remove, which the rollup below already expresses as a single op.
 */
async function findKindChangeRoots(
  changes: EntryChanges,
  rootAHash: Uint8Array,
  rootBHash: Uint8Array,
  keyA: KeyString,
  keyB: KeyString,
  adapter: StorageAdapter
): Promise<string[]> {
  const changedKeys = new Set<string>([
    ...changes.added.keys(),
    ...changes.removed,
    ...changes.modified.keys(),
  ]);

  const roots: string[] = [];
  const settled = new Map<string, boolean>();

  for (const key of [...changedKeys].sort()) {
    const segments = key.split('\x00');

    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join('\x00');
      if (roots.some(root => isUnderPrefix(path, root))) break;

      let differs = settled.get(path);
      if (differs === undefined) {
        const [kindA, kindB] = await Promise.all([
          kindOf(rootAHash, path, keyA, adapter),
          kindOf(rootBHash, path, keyB, adapter),
        ]);
        // An absent side means a plain add or remove; stop descending.
        if (kindA === 'absent' || kindB === 'absent') break;
        differs = kindA !== kindB;
        settled.set(path, differs);
      }

      if (differs) {
        roots.push(path);
        break;
      }
    }
  }

  return roots;
}

// ─── RFC 6902 op generation ───────────────────────────────────────────────────

async function changesToOps(
  changes: EntryChanges,
  rootAHash: Uint8Array,
  rootBHash: Uint8Array,
  keyA: KeyString,
  keyB: KeyString,
  adapter: StorageAdapter
): Promise<jsonpatch.Operation[]> {
  const ops: jsonpatch.Operation[] = [];

  // ── Kind changes ───────────────────────────────────────────────────────────
  // A path that holds a different *kind* of value in each document — an array
  // where the other has an object, an object where the other has a scalar —
  // cannot be reconciled entry by entry: the entry-level adds and removes would
  // mix with array index shifting and leave debris behind. Replace the whole
  // value at the shallowest such path and suppress everything beneath it.
  const shapeRoots = await findKindChangeRoots(changes, rootAHash, rootBHash, keyA, keyB, adapter);

  for (const key of shapeRoots) {
    const value = await readSubtree(rootBHash, key, keyB, adapter);
    ops.push({
      op: 'replace',
      path: treeKeyToPointer(key) as string,
      value: value === undefined ? null : value,
    });
  }

  const suppressed = (key: string) => shapeRoots.some(root => isUnderPrefix(key, root));

  // ── Removes ────────────────────────────────────────────────────────────────
  const coveredRemovals = new Set<string>();

  for (const key of [...changes.removed].sort()) {
    if (suppressed(key) || isCovered(key, coveredRemovals)) continue;

    const segments = key.split('\x00');
    let removeAt = key;

    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('\x00');
      if (!(await existsPrefix(rootBHash, prefix, keyB, adapter))) {
        removeAt = prefix;
        break;
      }
    }

    const pointer = treeKeyToPointer(removeAt) as string;
    if (!coveredRemovals.has(pointer)) {
      ops.push({ op: 'remove', path: pointer });
      coveredRemovals.add(pointer);
      coveredRemovals.add(removeAt + '\x00');
    }
  }

  // ── Adds ───────────────────────────────────────────────────────────────────
  const coveredAdds = new Set<string>();

  for (const key of [...changes.added.keys()].sort()) {
    if (suppressed(key) || isCovered(key, coveredAdds)) continue;

    // Roll the add up to the outermost ancestor that does not exist in A, so a
    // whole new subtree becomes one op instead of one op per leaf.
    const segments = key.split('\x00');
    let addAt = key;

    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('\x00');
      if (!(await existsPrefix(rootAHash, prefix, keyA, adapter))) {
        addAt = prefix;
        break;
      }
    }

    // Always rebuild the value from every added entry at or beneath `addAt`,
    // including any array marker. Taking the entry's own value instead would
    // emit the marker as the value whenever the added thing is an array.
    const subEntries = [...changes.added.entries()]
      .filter(([k]) => isUnderPrefix(k, addAt))
      .map(([k, v]) => [relativeKey(k, addAt), v] as [string, StoredValue])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const addValue = unflattenEntries(subEntries);

    const pointer = treeKeyToPointer(addAt) as string;
    if (!coveredAdds.has(pointer)) {
      ops.push({ op: 'add', path: pointer, value: addValue });
      coveredAdds.add(pointer);
      coveredAdds.add(addAt + '\x00');
    }
  }

  // ── Modifies ───────────────────────────────────────────────────────────────
  for (const [key, newValue] of changes.modified) {
    if (suppressed(key)) continue;
    ops.push({
      op: 'replace',
      path: treeKeyToPointer(key) as string,
      value: newValue as JSONValue,
    });
  }

  const removes = ops.filter(o => o.op === 'remove').sort((a, b) => b.path.localeCompare(a.path));
  const adds = ops.filter(o => o.op === 'add').sort((a, b) => a.path.localeCompare(b.path));
  const replaces = ops.filter(o => o.op !== 'remove' && o.op !== 'add').sort((a, b) => a.path.localeCompare(b.path));

  return [...removes, ...adds, ...replaces];
}

function isCovered(key: string, covered: Set<string>): boolean {
  const segments = key.split('\x00');
  for (let depth = 1; depth < segments.length; depth++) {
    const prefix = segments.slice(0, depth).join('\x00') + '\x00';
    if (covered.has(prefix)) return true;
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Produce an RFC 6902 patch that transforms the document at `keyA` into
 * the document at `keyB`, both on the same adapter.
 *
 * Uses chunkHash pruning to skip unchanged subtrees — O(changed nodes) reads
 * in the common case. Returns "[]" if the documents are identical.
 */
export async function diff(
  keyA: KeyString,
  keyB: KeyString,
  adapter: StorageAdapter,
): Promise<JSONPatchDocument> {
  const [blobA, blobB] = await Promise.all([
    adapter.readBlob(rootKey(keyA)),
    adapter.readBlob(rootKey(keyB)),
  ]);

  const rootA = decodeRootPointer(blobA);
  const rootB = decodeRootPointer(blobB);

  if (arraysEqual(rootA.entryHash, rootB.entryHash)) return toPatch('[]');

  const changes: EntryChanges = {
    added: new Map(),
    removed: new Set(),
    modified: new Map(),
  };

  await walkChanges(rootA.chunkHash, rootB.chunkHash, keyA, keyB, adapter, changes);

  if (changes.added.size === 0 && changes.removed.size === 0 && changes.modified.size === 0) {
    return toPatch('[]');
  }

  const ops = await changesToOps(changes, rootA.chunkHash, rootB.chunkHash, keyA, keyB, adapter);
  return toPatch(JSON.stringify(ops));
}
