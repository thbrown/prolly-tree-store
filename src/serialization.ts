import { encode, decode } from '@msgpack/msgpack';
import type { LeafNode, InternalNode, TreeNode, RootPointer, LeafEntry } from './types.js';
import { toBlob } from './types.js';
import type { JSONBlob, JSONValue } from './types.js';
import { toHex, hexToBytes } from './hashing.js';

const NODE_TYPE_LEAF = 0x02;
const NODE_TYPE_INTERNAL = 0x01;

// ─── JSON value ↔ MessagePack ─────────────────────────────────────────────────

export function encodeValue(value: JSONValue): Uint8Array {
  return encode(value);
}

export function decodeValue(bytes: Uint8Array): JSONValue {
  return decode(bytes) as JSONValue;
}

// ─── Tree nodes ───────────────────────────────────────────────────────────────

/**
 * Encode a LeafNode or InternalNode to raw msgpack bytes.
 * entryHash is included in the encoded bytes so it can be recovered on decode.
 * chunkHash is NOT included (it is the BLAKE3 of these very bytes).
 */
export function encodeNode(node: LeafNode | InternalNode): Uint8Array {
  if (node.type === NODE_TYPE_LEAF) {
    return encode({
      t: NODE_TYPE_LEAF,
      h: node.entryHash,
      e: node.entries.map(entry => ({ k: entry.key, v: entry.valueMsgpack })),
    });
  } else {
    return encode({
      t: NODE_TYPE_INTERNAL,
      h: node.entryHash,
      l: node.level,
      k: node.keys,
      c: node.children,
    });
  }
}

/**
 * Decode a node from its raw bytes.
 * entryHash is read from the encoded bytes.
 * chunkHash must be supplied by the caller (it was used to look up the blob).
 */
export function decodeNode(bytes: Uint8Array, chunkHash: Uint8Array): TreeNode {
  const raw = decode(bytes) as any;
  const entryHash = raw.h as Uint8Array;
  if (raw.t === NODE_TYPE_LEAF) {
    const entries: LeafEntry[] = (raw.e as any[]).map(e => ({
      key: e.k as string,
      valueMsgpack: e.v as Uint8Array,
    }));
    return {
      type: NODE_TYPE_LEAF,
      chunkHash,
      entryHash,
      entries,
    } satisfies LeafNode;
  } else {
    return {
      type: NODE_TYPE_INTERNAL,
      chunkHash,
      entryHash,
      level: raw.l as number,
      keys: raw.k as string[],
      children: raw.c as Uint8Array[],
    } satisfies InternalNode;
  }
}

// ─── RootPointer ─────────────────────────────────────────────────────────────

export function encodeRootPointer(root: RootPointer): JSONBlob {
  return toBlob(JSON.stringify({
    chunkHash: toHex(root.chunkHash),
    entryHash: toHex(root.entryHash),
    chunkSize: root.chunkSize,
    calibratedAt: root.calibratedAt,
  }));
}

export function decodeRootPointer(blob: JSONBlob): RootPointer {
  const raw = JSON.parse(blob as string);
  return {
    chunkHash: hexToBytes(raw.chunkHash),
    entryHash: hexToBytes(raw.entryHash),
    chunkSize: raw.chunkSize,
    calibratedAt: raw.calibratedAt,
  };
}

// ─── Node blob ↔ JSONBlob (base64) ────────────────────────────────────────────

export function nodeBytesToBlob(bytes: Uint8Array): JSONBlob {
  return toBlob(uint8ArrayToBase64(bytes));
}

export function blobToNodeBytes(blob: JSONBlob): Uint8Array {
  return base64ToUint8Array(blob as string);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
