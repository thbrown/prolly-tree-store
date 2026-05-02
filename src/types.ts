declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

// ─── Primitive branded types ──────────────────────────────────────────────────

export type KeyString = Brand<string, 'Key'>;
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [x: string]: JSONValue }
  | JSONValue[];
export type JSONBlob = Brand<string, 'JSONBlob'>;
export type JSONPatchDocument = Brand<string, 'JSONPatchDocument'>;
export type JSONPointer = Brand<string, 'JSONPointer'>;
export type ContentHash = Brand<string, 'ContentHash'>;

// ─── Internal cast helpers (no validation) ───────────────────────────────────

export const toKey = (s: string): KeyString => s as KeyString;
export const toBlob = (s: string): JSONBlob => s as JSONBlob;
export const toHash = (s: string): ContentHash => s as ContentHash;
export const toPatch = (s: string): JSONPatchDocument => s as JSONPatchDocument;
export const toPointer = (s: string): JSONPointer => s as JSONPointer;

// ─── Storage adapter ─────────────────────────────────────────────────────────

export interface StorageAdapter {
  persistBlob(key: KeyString, value: JSONBlob): Promise<void>;
  readBlob(key: KeyString): Promise<JSONBlob>;
  deleteBlob(key: KeyString): Promise<void>;
  readBlobs?(keys: KeyString[]): Promise<Map<KeyString, JSONBlob>>;
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface PartitionerState {
  overheadLatency: number;
  perKbLatency: number;
  chunkSize: number;
  prefetchWidth: number;
  cacheSizeBytes: number;
  calibratedAt: string;
  detectedBackend: 'indexeddb' | 'gcp' | 'unknown';
}

// ─── Constructor options ──────────────────────────────────────────────────────

export interface PartitionerOptions {
  adapter: StorageAdapter;
  initialState?: Partial<PartitionerState>;
  calibrationTtlMs?: number;
  writeRetries?: number;
}

// ─── Internal node types ──────────────────────────────────────────────────────

export interface LeafEntry {
  key: string;
  valueMsgpack: Uint8Array;
}

export interface LeafNode {
  type: 0x02;
  chunkHash: Uint8Array; // 32 bytes, BLAKE3 of serialised node bytes
  entryHash: Uint8Array; // 32 bytes, XOR-folded BLAKE3 of leaf entries
  entries: LeafEntry[];
}

export interface InternalNode {
  type: 0x01;
  chunkHash: Uint8Array;
  entryHash: Uint8Array;
  level: number;
  keys: string[];     // separator keys (first key of each child except the first)
  children: Uint8Array[]; // chunkHash of each child
}

export interface RootPointer {
  chunkHash: Uint8Array; // chunkHash of the root node blob
  entryHash: Uint8Array; // chunk-size-independent fingerprint
  chunkSize: number;
  calibratedAt: number; // unix ms
}

export type TreeNode = LeafNode | InternalNode;

// ─── Constants ────────────────────────────────────────────────────────────────

export const ROOT_PREFIX = '__root__/';
export const CHUNK_PREFIX = 'chunks/';
export const CALIBRATION_KEY = toKey('__calibration__');
export const AVG_ENTRY_SIZE = 128; // bytes, used to derive fanout from chunkSize
export const DEFAULT_CHUNK_SIZE = 4096;
export const DEFAULT_CALIBRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
