import { blake3 } from '@noble/hashes/blake3';
import { toHash } from './types.js';
import type { ContentHash } from './types.js';

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * BLAKE3 hash of raw bytes → 64-char hex ContentHash.
 * Used for chunkHash: content-addresses a serialised node blob.
 */
export function chunkHashOf(bytes: Uint8Array): ContentHash {
  return toHash(toHex(blake3(bytes)));
}

/**
 * XOR-folded BLAKE3 entry hash — chunk-size independent.
 *
 * Each (key, valueMsgpack) pair contributes BLAKE3("entry:" || key || valueMsgpack).
 * The contributions are XOR-folded so the result is independent of how entries
 * are grouped into chunks: XOR is commutative and associative.
 *
 * An empty set of entries returns 32 zero bytes (all-zero hash).
 */
export function entryHashOf(
  entries: { key: string; valueMsgpack: Uint8Array }[]
): Uint8Array {
  const acc = new Uint8Array(32);
  const prefix = encoder.encode('entry:');

  for (const { key, valueMsgpack } of entries) {
    const keyBytes = encoder.encode(key);
    const payload = new Uint8Array(prefix.length + keyBytes.length + valueMsgpack.length);
    payload.set(prefix, 0);
    payload.set(keyBytes, prefix.length);
    payload.set(valueMsgpack, prefix.length + keyBytes.length);
    const h = blake3(payload);
    for (let i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  return acc;
}

/**
 * XOR-combine two 32-byte entry hashes.
 * Used to compute a parent's entryHash from its children's entryHashes.
 */
export function combineEntryHashes(hashes: Uint8Array[]): Uint8Array {
  const acc = new Uint8Array(32);
  for (const h of hashes) {
    for (let i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  return acc;
}

/** Convert a 32-byte entryHash to a 64-char hex ContentHash. */
export function entryHashToContentHash(bytes: Uint8Array): ContentHash {
  return toHash(toHex(bytes));
}

/** Derive the chunk blob storage key from a 64-char hex chunkHash. */
export function chunkBlobKey(chunkHash: ContentHash): string {
  const hex = chunkHash as string;
  return `chunks/${hex.slice(0, 2)}/${hex}`;
}
