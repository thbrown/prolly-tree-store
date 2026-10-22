import type { LeafNode, InternalNode, TreeNode, StoredValue, LeafEntry } from './types.js';
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

export function fanoutFor(chunkSize: number): number {
  return Math.max(2, Math.round(chunkSize / AVG_ENTRY_SIZE));
}

function getModulus(level: number, chunkSize: number): number {
  const k = `${level}:${chunkSize}`;
  let m = modulusCache.get(k);
  if (m === undefined) {
    m = Math.pow(fanoutFor(chunkSize), level);
    modulusCache.set(k, m);
  }
  return m;
}

/**
 * True if `key` at `level` is a Prolly tree chunk boundary.
 *
 * Boundaries are content-defined: the same key at the same level always
 * produces the same answer, regardless of insertion order. Moduli are nested
 * powers of the fanout, so a level-2 boundary is always a level-1 boundary —
 * which is what makes the levels compose (see `groupChildren`).
 *
 * A hash of exactly zero would be a boundary at every level, which would nest
 * for ever, so it is excluded.
 */
export function isBoundary(key: string, level: number, chunkSize: number): boolean {
  const h = rollingHash(key);
  return h !== 0 && (h % getModulus(level, chunkSize)) === 0;
}

// ─── Nodes as seen by their parent ────────────────────────────────────────────

/**
 * What a parent needs to know about a child: where to find it, what it
 * contributes to the parent's entry hash, and the last key it covers.
 *
 * The last key does double duty. It routes lookups — a child holds every key up
 * to and including it — and it is the key the child's chunk closed on, which is
 * what the level above groups by.
 *
 * Internal nodes store all three for every child, which is what lets `patch`
 * split or drop a node without fetching its siblings: the parent already holds
 * each sibling's entry hash and last key.
 */
export interface Child {
  chunkHash: Uint8Array;
  entryHash: Uint8Array;
  lastKey: string;
}

export interface BuiltNode {
  node: TreeNode;
  bytes: Uint8Array;
  child: Child;
}

/** Group sorted leaf entries into leaves at content-defined boundaries. */
export function groupLeafEntries(
  entries: LeafEntry[],
  chunkSize: number
): LeafEntry[][] {
  const groups: LeafEntry[][] = [];
  let current: LeafEntry[] = [];

  for (const entry of entries) {
    current.push(entry);
    if (isBoundary(entry.key, 1, chunkSize)) {
      groups.push(current);
      current = [];
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Group a level's nodes into parents at content-defined boundaries.
 *
 * A group closes on a child whose last key is a boundary at the parent's level.
 * It has to be the *last* key, not the first: a chunk closes exactly when it
 * reaches a boundary key, so the next chunk's first key is by construction the
 * successor of a boundary and almost never a boundary itself. Grouping on first
 * keys therefore never splits a level — measured on a 1101-entry document, 0 of
 * 138 leaf first keys were boundaries at any level, so the tree came out as one
 * root with 138 children.
 *
 * Because each child's last key already cleared the level below, testing it
 * against this level's larger modulus closes a group with probability
 * 1/fanout — so the levels compose and the tree keeps its shape.
 *
 * The rule depends only on the child, never on its position, which is what lets
 * `patch` regroup one node's children and get the same answer a full rebuild
 * would.
 */
export function groupChildren(
  children: Child[],
  parentLevel: number,
  chunkSize: number
): Child[][] {
  const groups: Child[][] = [];
  let current: Child[] = [];

  for (const child of children) {
    current.push(child);
    if (isBoundary(child.lastKey, parentLevel + 1, chunkSize)) {
      groups.push(current);
      current = [];
    }
  }

  if (current.length > 0) groups.push(current);

  // Every child closing its own group would leave the level the same size and
  // never terminate. Vanishingly rare, but cheap to rule out.
  return groups.length === children.length && children.length > 1 ? [children] : groups;
}

export function makeLeaf(entries: LeafEntry[]): BuiltNode {
  const entryHash = entryHashOf(entries);

  // Encode with a zero chunkHash: the hash covers these very bytes.
  const partial: LeafNode = {
    type: 0x02,
    chunkHash: new Uint8Array(32),
    entryHash,
    entries,
  };
  const bytes = encodeNode(partial);
  const chunkHash = hexToBytes(chunkHashOf(bytes) as string);

  return {
    node: { type: 0x02, chunkHash, entryHash, entries },
    bytes,
    child: { chunkHash, entryHash, lastKey: entries[entries.length - 1]?.key ?? '' },
  };
}

/** Encode values, then build a leaf. Used by the full-document build path. */
export function makeLeafFromValues(entries: [string, StoredValue][]): BuiltNode {
  return makeLeaf(
    entries.map(([key, value]) => ({ key, valueMsgpack: encodeValue(value) }))
  );
}

export function makeInternal(children: Child[], level: number): BuiltNode {
  const entryHash = combineEntryHashes(children.map(c => c.entryHash));

  const partial: InternalNode = {
    type: 0x01,
    chunkHash: new Uint8Array(32),
    entryHash,
    level,
    keys: children.map(c => c.lastKey),
    children: children.map(c => c.chunkHash),
    childEntryHashes: children.map(c => c.entryHash),
  };
  const bytes = encodeNode(partial);
  const chunkHash = hexToBytes(chunkHashOf(bytes) as string);

  return {
    node: { ...partial, chunkHash },
    bytes,
    child: { chunkHash, entryHash, lastKey: children[children.length - 1].lastKey },
  };
}

/** Read an internal node's children back out in `Child` form. */
export function childrenOf(node: InternalNode): Child[] {
  return node.children.map((chunkHash, i) => ({
    chunkHash,
    entryHash: node.childEntryHashes[i],
    lastKey: node.keys[i],
  }));
}

// ─── Full-document build ──────────────────────────────────────────────────────

export interface BuiltTree {
  root: TreeNode;
  rootBytes: Uint8Array;
  /** All nodes keyed by hex(chunkHash). Values are the serialised node bytes. */
  allNodes: Map<string, Uint8Array>;
}

/**
 * Build a complete Prolly tree from sorted (key, value) entries.
 *
 * This defines the canonical layout for a given set of entries and chunk size;
 * `compact()` restores a patched document to exactly this shape.
 */
export function buildTree(
  entries: [string, StoredValue][],
  chunkSize: number
): BuiltTree {
  const allNodes = new Map<string, Uint8Array>();
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const leafEntries = sorted.map(
    ([key, value]) => ({ key, valueMsgpack: encodeValue(value) })
  );

  // An empty document is a single empty leaf.
  const groups = leafEntries.length === 0 ? [[]] : groupLeafEntries(leafEntries, chunkSize);
  let builtLevel = groups.map(group => makeLeaf(group));
  for (const built of builtLevel) allNodes.set(toHex(built.child.chunkHash), built.bytes);

  // Each pass closes a group on at most every second child, so the level always
  // shrinks and the loop terminates.
  let level = 1;
  while (builtLevel.length > 1) {
    const parents = groupChildren(builtLevel.map(b => b.child), level, chunkSize);
    builtLevel = parents.map(group => makeInternal(group, level));
    for (const built of builtLevel) allNodes.set(toHex(built.child.chunkHash), built.bytes);
    level++;
  }

  const root = builtLevel[0];
  return { root: root.node, rootBytes: root.bytes, allNodes };
}
