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

// ─── Array marker ─────────────────────────────────────────────────────────────

declare const arrayMarkerBrand: unique symbol;
export interface ArrayMarker {
  readonly [arrayMarkerBrand]: true;
}

/**
 * Sentinel stored at an array's own tree key to record that the container is an
 * array rather than an object. Serialised as a msgpack extension type, which no
 * JSON value can produce, so it is unambiguous — and because it lives inside
 * `valueMsgpack` it contributes to `entryHash`, making container shape part of
 * the content identity.
 */
export const ARRAY_MARKER = Object.freeze({}) as unknown as ArrayMarker;

/** A value as stored in a leaf entry: any JSON value, or the array marker. */
export type StoredValue = JSONValue | ArrayMarker;

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
  /** Optional batch read, used to skip writing chunks that already exist. */
  readBlobs?(keys: KeyString[]): Promise<Map<KeyString, JSONBlob>>;
  /**
   * Optional prefix listing. Required by `gc()`, which has no other way to find
   * blobs that are no longer referenced. Both IndexedDB (key ranges) and GCS
   * (prefix queries) support this.
   */
  listBlobs?(prefix: string): Promise<KeyString[]>;
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface PartitionerState {
  /** Measured fixed cost of one read, in milliseconds. */
  overheadLatency: number;
  /** Measured marginal cost of reading one further KB, in milliseconds. */
  perKbLatency: number;
  /** Target size of a tree node blob, in bytes — the only tuned parameter. */
  chunkSize: number;
  calibratedAt: string;
  detectedBackend: 'indexeddb' | 'gcp' | 'unknown';
}

// ─── Constructor options ──────────────────────────────────────────────────────

export interface PartitionerOptions {
  adapter: StorageAdapter;
  initialState?: Partial<PartitionerState>;
  calibrationTtlMs?: number;
  writeRetries?: number;
  /**
   * Keep chunks that a `put` replaced instead of deleting them immediately.
   *
   * Deleting straight away can break a reader that is midway through the old
   * version of the tree — another tab, or a peer that read the root pointer a
   * moment ago. Retaining them trades storage for that safety; `gc(key)`
   * reclaims them once readers have moved on. Defaults to false.
   */
  retainStaleChunks?: boolean;
  /**
   * Optional document-level transform applied to the value before it is
   * flattened and stored. `decoder` is the inverse, applied after the
   * document is reconstructed from the tree on `get()`.
   *
   * When set, `diff()` and `patch()` operate on the *encoded* stored form, so
   * patches produced by `diff()` reference encoded paths (e.g. `/$abc/_name`).
   * Manual RFC 6902 patches passed to `patch()` must also use encoded paths.
   * Pointers passed to `get(key, pointer)` must reference the encoded form.
   */
  encoder?: (doc: JSONValue) => JSONValue;
  decoder?: (doc: JSONValue) => JSONValue;
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
  format: number; // on-disk format version — see FORMAT_VERSION
  chunkHash: Uint8Array; // chunkHash of the root node blob
  entryHash: Uint8Array; // chunk-size-independent fingerprint
  chunkSize: number;
  calibratedAt: number; // unix ms
}

export type TreeNode = LeafNode | InternalNode;

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * On-disk format version, written into every root pointer.
 *
 * v2 made container shape explicit (see ARRAY_MARKER), fixed array indices to be
 * dense, and stopped double-escaping pointer segments. v1 trees are not readable.
 */
export const FORMAT_VERSION = 2;

export const ROOT_PREFIX = '__root__/';
export const CHUNK_PREFIX = 'chunks/';
export const CALIBRATION_KEY = toKey('__calibration__');
export const AVG_ENTRY_SIZE = 128; // bytes, used to derive fanout from chunkSize
export const DEFAULT_CHUNK_SIZE = 4096;
export const DEFAULT_CALIBRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
