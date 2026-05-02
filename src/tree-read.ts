import type {
  StorageAdapter,
  KeyString,
  JSONValue,
  ContentHash,
  LeafNode,
  InternalNode,
  RootPointer,
} from './types.js';
import { toKey } from './types.js';
import { BlobNotFoundError } from './errors.js';
import { decodeRootPointer, decodeValue } from './serialization.js';
import { entryHashToContentHash } from './hashing.js';
import { pointerToTreeKey, unflattenEntries } from './encoding.js';
import type { JSONPointer } from './types.js';
import { rootKey, chunkKey, fetchNode } from './tree-utils.js';

async function fetchRootPointer(
  key: KeyString,
  adapter: StorageAdapter
): Promise<RootPointer> {
  const blob = await adapter.readBlob(rootKey(key));
  return decodeRootPointer(blob);
}

/**
 * Return the entry-hash (chunk-size-independent fingerprint) of the document at `key`.
 * Only fetches the root pointer blob — never fetches leaf or internal nodes.
 */
export async function getRootHash(
  key: KeyString,
  adapter: StorageAdapter
): Promise<ContentHash> {
  const root = await fetchRootPointer(key, adapter);
  return entryHashToContentHash(root.entryHash);
}

/**
 * Retrieve a full document or sub-tree at `pointer`.
 *
 * Without `pointer` (or empty string): returns the entire stored document.
 * With `pointer`: walks only the subtree covering that key prefix.
 */
export async function get(
  key: KeyString,
  adapter: StorageAdapter,
  pointer?: JSONPointer
): Promise<JSONValue> {
  const rootPtr = await fetchRootPointer(key, adapter);

  const treeKeyPrefix = pointer ? pointerToTreeKey(pointer) : '';

  const entries = await collectEntries(rootPtr.chunkHash, treeKeyPrefix, key, adapter);

  if (entries.length === 0) {
    if (pointer && pointer !== '' as JSONPointer) {
      throw new BlobNotFoundError(toKey(`${key as string}${pointer as string}`));
    }
    return {};
  }

  if (!pointer || pointer === '' as JSONPointer) {
    return unflattenEntries(entries);
  }

  const prefix = treeKeyPrefix;
  const subEntries = entries
    .filter(([k]) => k === prefix || k.startsWith(prefix === '' ? '' : prefix + '\x00'))
    .map(([k, v]) => {
      const rest = prefix === '' ? k : k.slice(prefix.length + 1);
      return [rest, v] as [string, JSONValue];
    });

  if (subEntries.length === 1 && subEntries[0][0] === '') {
    return subEntries[0][1];
  }

  const exact = entries.find(([k]) => k === prefix);
  if (exact) return exact[1];

  return unflattenEntries(subEntries);
}

async function collectEntries(
  chunkHashBytes: Uint8Array,
  prefix: string,
  docKey: KeyString,
  adapter: StorageAdapter,
): Promise<[string, JSONValue][]> {
  const node = await fetchNode(chunkHashBytes, docKey, adapter);

  if (node.type === 0x02) {
    const leaf = node as LeafNode;
    return leaf.entries
      .filter(e => prefix === '' || e.key === prefix || e.key.startsWith(prefix + '\x00'))
      .map(e => [e.key, decodeValue(e.valueMsgpack)] as [string, JSONValue]);
  }

  const internal = node as InternalNode;
  const relevantChildren = findRelevantChildren(internal, prefix);

  const childArrays = await Promise.all(
    relevantChildren.map(({ chunkHash }) => collectEntries(chunkHash, prefix, docKey, adapter))
  );
  return childArrays.flat();
}

function findRelevantChildren(
  node: InternalNode,
  prefix: string
): { chunkHash: Uint8Array }[] {
  if (prefix === '') {
    return node.children.map(chunkHash => ({ chunkHash }));
  }

  const result: { chunkHash: Uint8Array }[] = [];

  for (let i = 0; i < node.children.length; i++) {
    const lo = i === 0 ? '' : node.keys[i - 1];
    const hi = i < node.keys.length ? node.keys[i] : null;

    const loOk = lo === '' || lo <= prefix || lo.startsWith(prefix) || prefix.startsWith(lo);
    const hiOk = hi === null || hi > prefix;

    if (loOk && hiOk) {
      result.push({ chunkHash: node.children[i] });
    }
  }

  return result;
}
