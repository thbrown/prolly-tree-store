import type { StorageAdapter, KeyString, TreeNode } from './types.js';
import { ROOT_PREFIX, toKey } from './types.js';
import { toHex } from './hashing.js';
import { decodeNode, blobToNodeBytes } from './serialization.js';

export { toHex };
export { hexToBytes } from './hashing.js';

export function rootKey(docKey: KeyString): KeyString {
  return toKey(ROOT_PREFIX + (docKey as string));
}

export function chunkKey(docKey: KeyString, chunkHashBytes: Uint8Array): KeyString {
  const hex = toHex(chunkHashBytes);
  return toKey(`chunks/${docKey as string}/${hex.slice(0, 2)}/${hex}`);
}

export async function fetchNode(
  chunkHashBytes: Uint8Array,
  docKey: KeyString,
  adapter: StorageAdapter
): Promise<TreeNode> {
  const blob = await adapter.readBlob(chunkKey(docKey, chunkHashBytes));
  return decodeNode(blobToNodeBytes(blob), chunkHashBytes);
}
