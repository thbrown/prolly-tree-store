import type {
  StorageAdapter,
  KeyString,
  LeafEntry,
  LeafNode,
  InternalNode,
} from './types.js';
import { prefixUpperBound, isUnderPrefix } from './encoding.js';
import { isArrayMarkerBytes } from './serialization.js';
import { fetchNode } from './tree-utils.js';
import type { NodeCache } from './tree-utils.js';

/**
 * Read access to a document's leaf entries by key or key prefix.
 *
 * `patch` builds its pending mutations against an overlay that implements this
 * same interface, so pointer resolution and value reads work identically
 * against committed storage and against uncommitted in-flight changes.
 */
export interface EntryReader {
  /** The entry stored at exactly `key`, or null. */
  getEntry(key: string): Promise<LeafEntry | null>;
  /** Every entry at or beneath `prefix`. `''` returns the whole document. */
  scanPrefix(prefix: string): Promise<LeafEntry[]>;
  /** Whether any entry exists at or beneath `prefix`. */
  existsPrefix(prefix: string): Promise<boolean>;
}

/**
 * Whether child `i` of an internal node can contain keys under `prefix`.
 *
 * Child `i` covers the key range `[lo, hi)`, where `lo` is its separator key
 * (`''` for the first child) and `hi` is the next child's separator (`null` for
 * the last). The keys under `prefix` occupy `[prefix, prefixUpperBound(prefix))`,
 * so the two ranges overlap exactly when the test below holds.
 *
 * The empty prefix is the whole document rather than a bounded range, so it
 * matches every child.
 */
function childOverlapsPrefix(lo: string, hi: string | null, prefix: string): boolean {
  if (prefix === '') return true;
  return lo < prefixUpperBound(prefix) && (hi === null || hi > prefix);
}

function childRange(node: InternalNode, i: number): [string, string | null] {
  return [
    i === 0 ? '' : node.keys[i - 1],
    i < node.keys.length ? node.keys[i] : null,
  ];
}

/** Index of the single child whose range contains `key`. */
function childIndexForKey(node: InternalNode, key: string): number {
  for (let i = node.keys.length - 1; i >= 0; i--) {
    if (key >= node.keys[i]) return i + 1;
  }
  return 0;
}

/** Every entry at or beneath `prefix`, in no particular order. */
export async function scanPrefix(
  rootHash: Uint8Array,
  prefix: string,
  docKey: KeyString,
  adapter: StorageAdapter,
  cache?: NodeCache
): Promise<LeafEntry[]> {
  const node = await fetchNode(rootHash, docKey, adapter, cache);

  if (node.type === 0x02) {
    return (node as LeafNode).entries.filter(e => isUnderPrefix(e.key, prefix));
  }

  const internal = node as InternalNode;
  const relevant: Uint8Array[] = [];
  for (let i = 0; i < internal.children.length; i++) {
    const [lo, hi] = childRange(internal, i);
    if (childOverlapsPrefix(lo, hi, prefix)) relevant.push(internal.children[i]);
  }

  const childResults = await Promise.all(
    relevant.map(child => scanPrefix(child, prefix, docKey, adapter, cache))
  );
  return childResults.flat();
}

/** The entry stored at exactly `key`, or null. Follows a single root-to-leaf path. */
export async function getEntry(
  rootHash: Uint8Array,
  key: string,
  docKey: KeyString,
  adapter: StorageAdapter,
  cache?: NodeCache
): Promise<LeafEntry | null> {
  let hash = rootHash;

  for (;;) {
    const node = await fetchNode(hash, docKey, adapter, cache);
    if (node.type === 0x02) {
      return (node as LeafNode).entries.find(e => e.key === key) ?? null;
    }
    const internal = node as InternalNode;
    hash = internal.children[childIndexForKey(internal, key)];
  }
}

/**
 * Whether any entry exists at or beneath `prefix`, stopping at the first hit.
 *
 * With `strict`, the entry at exactly `prefix` does not count — the question
 * becomes whether the key has descendants, which is how a container is told
 * apart from a leaf value.
 */
export async function existsPrefix(
  rootHash: Uint8Array,
  prefix: string,
  docKey: KeyString,
  adapter: StorageAdapter,
  strict = false,
  cache?: NodeCache
): Promise<boolean> {
  const node = await fetchNode(rootHash, docKey, adapter, cache);

  if (node.type === 0x02) {
    return (node as LeafNode).entries.some(
      e => isUnderPrefix(e.key, prefix) && !(strict && e.key === prefix)
    );
  }

  const internal = node as InternalNode;
  for (let i = 0; i < internal.children.length; i++) {
    const [lo, hi] = childRange(internal, i);
    if (!childOverlapsPrefix(lo, hi, prefix)) continue;
    if (await existsPrefix(internal.children[i], prefix, docKey, adapter, strict, cache)) return true;
  }
  return false;
}

/** The kind of value a document holds at a key. */
export type ValueKind = 'absent' | 'leaf' | 'array' | 'object';

/**
 * Classify what is stored at `key`.
 *
 * Arrays always carry a marker entry at their own key; objects never do (an
 * empty object is stored as its own `{}` value and so reads as a leaf). That is
 * enough to tell the three kinds apart, which `diff` needs in order to notice a
 * path whose shape changed rather than whose contents changed.
 */
export async function kindOf(
  rootHash: Uint8Array,
  key: string,
  docKey: KeyString,
  adapter: StorageAdapter,
  cache?: NodeCache
): Promise<ValueKind> {
  const [entry, hasDescendants] = await Promise.all([
    getEntry(rootHash, key, docKey, adapter, cache),
    existsPrefix(rootHash, key, docKey, adapter, true, cache),
  ]);

  if (entry === null) return hasDescendants ? 'object' : 'absent';
  if (isArrayMarkerBytes(entry.valueMsgpack)) return 'array';
  return hasDescendants ? 'object' : 'leaf';
}

/** An `EntryReader` over the committed tree rooted at `rootHash`. */
export function treeReader(
  rootHash: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter,
  cache?: NodeCache
): EntryReader {
  return {
    getEntry: key => getEntry(rootHash, key, docKey, adapter, cache),
    scanPrefix: prefix => scanPrefix(rootHash, prefix, docKey, adapter, cache),
    existsPrefix: prefix => existsPrefix(rootHash, prefix, docKey, adapter, false, cache),
  };
}
