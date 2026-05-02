# prolly-tree-store

A Merkle Prolly Tree storage library for syncing large JSON documents efficiently. Content-addressed, storage-agnostic, and designed for incremental sync between a browser (IndexedDB) and a server (GCS or filesystem).

## Key properties

- **O(log n) reads and writes** — only fetches nodes on the path to changed leaves
- **O(changed nodes) diffs** — walks two trees in lockstep, pruning identical subtrees with a single hash comparison
- **O(K · log n) patches** — applies K mutations directly to affected leaves without loading the full document
- **Cross-chunk-size hash stability** — the same document always produces the same `entryHash` regardless of chunk size, so adapters with different configurations can be compared
- **Structural sharing** — unchanged subtrees are never re-written; two documents sharing a subtree store its nodes once

## Installation

```bash
npm install prolly-tree-store
```

## Quick start

```typescript
import { ProllyTreeStore, MemoryStorageAdapter } from 'prolly-tree-store';

const store = new ProllyTreeStore({
  adapter: new MemoryStorageAdapter(),
});

const K = ProllyTreeStore.asKey;

await store.put(K('game-state'), { inning: 1, score: [0, 0] });

const doc = await store.get(K('game-state'));

await store.patch(K('game-state'), JSON.stringify([
  { op: 'replace', path: '/inning', value: 2 },
  { op: 'replace', path: '/score/0', value: 3 },
]) as any);

const hash = await store.getRootHash(K('game-state'));
// 64-char hex — chunk-size independent
```

## API

### `new ProllyTreeStore(options)`

| Option | Type | Description |
|---|---|---|
| `adapter` | `StorageAdapter` | Storage backend |
| `initialState` | `Partial<PartitionerState>` | Skip calibration (useful in tests; set `chunkSize`) |
| `calibrationTtlMs` | `number` | How long to cache calibration results (default 7 days) |

### `put(key, value)` → `ContentHash`

Stores a full JSON document. Builds a Prolly tree from scratch, deduplicating blobs that already exist in the adapter. Returns a chunk-size-independent content hash.

### `get(key, pointer?)` → `JSONValue`

Retrieves a document or sub-value. `pointer` is an RFC 6901 JSON Pointer (`'/players/0/name'`). With a pointer, only the relevant subtree is fetched — O(log n + result size).

### `patch(key, patches)` → `ContentHash`

Applies an RFC 6902 patch without loading the full document. Mutations are routed to affected leaf nodes; entry hashes are propagated up using XOR — no sibling nodes fetched. `test` ops are validated via partial reads before any write.

### `diff(keyA, keyB)` → `JSONPatchDocument`

Produces an RFC 6902 patch transforming `keyA` into `keyB`. Walks both trees simultaneously, pruning subtrees whose entry hashes match. Returns `'[]'` immediately if the documents are identical.

### `getRootHash(key)` → `ContentHash`

Returns the chunk-size-independent entry hash without fetching any tree nodes. Useful for cheap change detection.

### `delete(key)` → `void`

Removes the document and all its chunk blobs. No-op if the key does not exist.

### `calibrate()` → `PartitionerState`

Measures adapter latency and derives optimal `chunkSize` / `prefetchWidth`. Called automatically on the first `put`/`patch` unless `initialState` is provided.

### Static helpers

```typescript
ProllyTreeStore.asKey('my-doc')     // validates non-empty, returns KeyString
ProllyTreeStore.asPointer('/a/b')   // validates RFC 6901 format, returns JSONPointer
```

## Implementing a StorageAdapter

```typescript
interface StorageAdapter {
  persistBlob(key: KeyString, value: JSONBlob): Promise<void>;
  readBlob(key: KeyString): Promise<JSONBlob>;        // throw BlobNotFoundError if missing
  deleteBlob(key: KeyString): Promise<void>;
  readBlobs?(keys: KeyString[]): Promise<Map<KeyString, JSONBlob>>; // optional batch read
}
```

Blob values are opaque strings. Key patterns:
- `__root__/{docKey}` — root pointer (small JSON, one per document)
- `chunks/{xx}/{64-char-hex}` — tree node addressed by its BLAKE3 hash (base64-encoded msgpack)

Because chunk keys are content-addressed, `persistBlob` is idempotent — writing the same chunk twice is safe. The library uses `readBlobs` (if provided) to batch-check which chunks already exist before writing, avoiding redundant writes.

## Running tests

```bash
npm test                                    # all tests with coverage
npx vitest run test/chaos.test.ts           # chaos / fuzz test (~5s)
```

## Design notes

**entryHash vs chunkHash** — Each node carries two hashes. `chunkHash` is the BLAKE3 of the node's serialized bytes and is used for content-addressing blobs. `entryHash` is an XOR-folded BLAKE3 over all descendant leaf `(key, value)` pairs; it is the same for the same document regardless of chunk size. `getRootHash` returns the `entryHash`; structural sharing checks use `chunkHash`.

**Prolly boundaries** — Chunk splits are determined by `rollingHash(key) mod fanout`, where `fanout = chunkSize / AVG_ENTRY_SIZE`. Because boundaries depend only on keys (not values), updating a value never changes tree structure. Insert/delete may change structure near the modified key, but the `put` function always rebuilds from the correct canonical form.

**Concurrency** — Chunk writes are safe to race (content-addressed, idempotent). Root pointer writes are last-writer-wins. For strong concurrency guarantees (e.g. GCS), the `StorageAdapter` should use conditional writes (`ifGenerationMatch`) on root pointer keys and expose an optional `conditionalPersistBlob` method.
