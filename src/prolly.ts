import type { LeafNode, InternalNode, TreeNode, JSONValue } from './types.js';
import { AVG_ENTRY_SIZE } from './types.js';
import { encodeValue, encodeNode } from './serialization.js';
import { chunkHashOf, entryHashOf, combineEntryHashes, toHex, hexToBytes } from './hashing.js';

// ─── Rolling hash for boundary detection ──────────────────────────────────────

/**
 * djb2-style rolling hash of a string key.
 * Deterministic across runtimes — does not use Math.random or Date.
 */
export function rollingHash(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (((h << 5) + h) + key.charCodeAt(i)) >>> 0; // force unsigned 32-bit
  }
  return h;
}

const modulusCache = new Map<string, number>();

function getModulus(level: number, chunkSize: number): number {
  const k = `${level}:${chunkSize}`;
  let m = modulusCache.get(k);
  if (m === undefined) {
    const fanout = Math.max(2, Math.round(chunkSize / AVG_ENTRY_SIZE));
    m = Math.pow(fanout, level);
    modulusCache.set(k, m);
  }
  return m;
}

/**
 * True if `key` at `level` is a Prolly tree chunk boundary.
 * Boundaries are content-defined: the same key at the same level always
 * produces the same answer, regardless of insertion order.
 */
export function isBoundary(key: string, level: number, chunkSize: number): boolean {
  return (rollingHash(key) % getModulus(level, chunkSize)) === 0;
}

// ─── Node construction ────────────────────────────────────────────────────────

export interface BuiltLeaf {
  node: LeafNode;
  bytes: Uint8Array;
  firstKey: string;
}

export interface BuiltInternal {
  node: InternalNode;
  bytes: Uint8Array;
  firstKey: string;
}

export interface BuiltTree {
  root: TreeNode;
  rootBytes: Uint8Array;
  /** All nodes keyed by hex(chunkHash). Values are the serialised node bytes. */
  allNodes: Map<string, Uint8Array>;
}

/**
 * Group sorted (key, value) entries into leaf nodes using Prolly boundaries.
 * Guarantees at least one leaf even if no boundaries are found.
 */
export function buildLeafNodes(
  entries: [string, JSONValue][],
  chunkSize: number
): BuiltLeaf[] {
  if (entries.length === 0) {
    // Empty tree — single empty leaf
    const leaf = makeLeaf([]);
    return [leaf];
  }

  const leaves: BuiltLeaf[] = [];
  let current: [string, JSONValue][] = [];

  for (const entry of entries) {
    current.push(entry);
    if (isBoundary(entry[0], 1, chunkSize) && current.length > 0) {
      leaves.push(makeLeaf(current));
      current = [];
    }
  }

  if (current.length > 0) {
    leaves.push(makeLeaf(current));
  }

  return leaves;
}

function makeLeaf(entries: [string, JSONValue][]): BuiltLeaf {
  const leafEntries = entries.map(([key, value]) => ({
    key,
    valueMsgpack: encodeValue(value),
  }));

  const entryHash = entryHashOf(leafEntries);

  // Encode without hashes first to compute chunkHash
  const partial: LeafNode = {
    type: 0x02,
    chunkHash: new Uint8Array(32),
    entryHash,
    entries: leafEntries,
  };
  const bytes = encodeNode(partial);
  const chunkHash = chunkHashOf(bytes);

  const node: LeafNode = {
    type: 0x02,
    chunkHash: hexToBytes(chunkHash as string),
    entryHash,
    entries: leafEntries,
  };

  return { node, bytes, firstKey: leafEntries[0]?.key ?? '' };
}

/**
 * Build one level of internal nodes from the nodes at the level below.
 * Uses the same Prolly boundary function (with level+1) for stability.
 */
export function buildInternalLevel(
  children: (BuiltLeaf | BuiltInternal)[],
  level: number,
  chunkSize: number
): BuiltInternal[] {
  if (children.length <= 1) {
    // No point in internal node over a single child — caller should handle this
    return [];
  }

  const internals: BuiltInternal[] = [];
  let current: (BuiltLeaf | BuiltInternal)[] = [];

  for (const child of children) {
    current.push(child);
    if (current.length > 1 && isBoundary(child.firstKey, level, chunkSize)) {
      internals.push(makeInternal(current, level));
      current = [];
    }
  }

  if (current.length > 0) {
    internals.push(makeInternal(current, level));
  }

  return internals;
}

function makeInternal(
  children: (BuiltLeaf | BuiltInternal)[],
  level: number
): BuiltInternal {
  // Separator keys: actual first key of each child except the first
  const keys = children.slice(1).map(c => c.firstKey);
  const childHashes = children.map(c => c.node.chunkHash);
  const childEntryHashes = children.map(c => c.node.entryHash);
  const entryHash = combineEntryHashes(childEntryHashes);

  const partial: InternalNode = {
    type: 0x01,
    chunkHash: new Uint8Array(32),
    entryHash,
    level,
    keys,
    children: childHashes,
  };
  const bytes = encodeNode(partial);
  const chunkHash = chunkHashOf(bytes);

  const node: InternalNode = {
    type: 0x01,
    chunkHash: hexToBytes(chunkHash as string),
    entryHash,
    level,
    keys,
    children: childHashes,
  };

  return { node, bytes, firstKey: children[0].firstKey };
}

/**
 * Build a complete Prolly tree from sorted (key, value) entries.
 * Returns the root node, its bytes, and a map of all chunkHash → bytes.
 */
export function buildTree(
  entries: [string, JSONValue][],
  chunkSize: number
): BuiltTree {
  const allNodes = new Map<string, Uint8Array>();

  // Sort entries by tree key
  const sorted = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  // Build leaves
  const leaves = buildLeafNodes(sorted, chunkSize);
  for (const { node, bytes } of leaves) {
    allNodes.set(toHex(node.chunkHash), bytes);
  }

  if (leaves.length === 1) {
    return { root: leaves[0].node, rootBytes: leaves[0].bytes, allNodes };
  }

  // Build internal levels until we have a single root
  let currentLevel: (BuiltLeaf | BuiltInternal)[] = leaves;
  let level = 1;

  while (currentLevel.length > 1) {
    const internals = buildInternalLevel(currentLevel, level, chunkSize);

    if (internals.length === 0) {
      // All children fell into one group — wrap them all in one internal node
      const single = makeInternal(currentLevel, level);
      allNodes.set(toHex(single.node.chunkHash), single.bytes);
      return { root: single.node, rootBytes: single.bytes, allNodes };
    }

    for (const { node, bytes } of internals) {
      allNodes.set(toHex(node.chunkHash), bytes);
    }

    if (internals.length === 1) {
      return { root: internals[0].node, rootBytes: internals[0].bytes, allNodes };
    }

    currentLevel = internals;
    level++;
  }

  const last = currentLevel[0];
  return { root: last.node, rootBytes: last.bytes, allNodes };
}

