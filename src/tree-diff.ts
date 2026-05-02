import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  JSONPatchDocument,
  LeafNode,
  InternalNode,
} from './types.js';
import { toPatch } from './types.js';
import {
  decodeRootPointer,
  decodeValue,
} from './serialization.js';
import { unflattenEntries, treeKeyToPointer } from './encoding.js';
import * as jsonpatch from 'fast-json-patch';
import { rootKey, fetchNode } from './tree-utils.js';

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

async function hasKeyWithPrefix(
  prefix: string,
  chunkHashBytes: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter
): Promise<boolean> {
  const node = await fetchNode(chunkHashBytes, docKey, adapter);

  if (node.type === 0x02) {
    const leaf = node as LeafNode;
    return leaf.entries.some(
      e => e.key === prefix || e.key.startsWith(prefix + '\x00')
    );
  }

  const internal = node as InternalNode;
  for (let i = 0; i < internal.children.length; i++) {
    const lo = i === 0 ? '' : internal.keys[i - 1];
    const hi = i < internal.keys.length ? internal.keys[i] : null;
    const loOk = lo === '' || lo <= prefix || lo.startsWith(prefix) || prefix.startsWith(lo + '\x00') || prefix >= lo;
    const hiOk = hi === null || hi > prefix || hi.startsWith(prefix);
    if (loOk && hiOk) {
      if (await hasKeyWithPrefix(prefix, internal.children[i], docKey, adapter)) return true;
    }
  }
  return false;
}

// ─── Entry-level change collection ───────────────────────────────────────────

interface EntryChanges {
  added: Map<string, JSONValue>;
  removed: Set<string>;
  modified: Map<string, JSONValue>;
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

  // ── Removes ────────────────────────────────────────────────────────────────
  const coveredRemovals = new Set<string>();

  for (const key of [...changes.removed].sort()) {
    if (isCovered(key, coveredRemovals)) continue;

    const segments = key.split('\x00');
    let removeAt = key;

    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('\x00');
      if (!(await hasKeyWithPrefix(prefix, rootBHash, keyB, adapter))) {
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
    if (isCovered(key, coveredAdds)) continue;

    const segments = key.split('\x00');
    let addAt = key;
    let addValue: JSONValue = changes.added.get(key)!;

    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('\x00');
      if (!(await hasKeyWithPrefix(prefix, rootAHash, keyA, adapter))) {
        addAt = prefix;
        const subEntries = [...changes.added.entries()]
          .filter(([k]) => k === prefix || k.startsWith(prefix + '\x00'))
          .map(([k, v]) => {
            const rest = k === prefix ? '' : k.slice(prefix.length + 1);
            return [rest, v] as [string, JSONValue];
          })
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        addValue = unflattenEntries(subEntries);
        break;
      }
    }

    const pointer = treeKeyToPointer(addAt) as string;
    if (!coveredAdds.has(pointer)) {
      ops.push({ op: 'add', path: pointer, value: addValue });
      coveredAdds.add(pointer);
      coveredAdds.add(addAt + '\x00');
    }
  }

  // ── Modifies ───────────────────────────────────────────────────────────────
  for (const [key, newValue] of changes.modified) {
    ops.push({ op: 'replace', path: treeKeyToPointer(key) as string, value: newValue });
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
