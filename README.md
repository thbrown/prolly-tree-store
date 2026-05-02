# prolly-tree-store

A Merkle Prolly Tree storage library for syncing large JSON documents efficiently. Content-addressed, storage-agnostic, and designed for incremental sync between any two storage backends.

## Key properties

- **O(log n) reads and writes** — only fetches nodes on the path to changed leaves
- **O(changed nodes) diffs** — walks two trees in lockstep, pruning identical subtrees with a single hash comparison
- **O(K · log n) patches** — applies K mutations directly to affected leaves without loading the full document
- **Cross-chunk-size hash stability** — the same document always produces the same `entryHash` regardless of chunk size, so adapters with different configurations can be compared
- **Structural sharing** — unchanged subtrees are never re-written; two documents sharing a subtree store its nodes once
- **RFC 6902 compliant patches and diffs** — `patch` accepts standard JSON Patch documents; `diff` produces them

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
const P = ProllyTreeStore.asPointer;

// Store a document
await store.put(K('roster'), {
  team: 'Red Sox',
  players: [
    { id: 1, name: 'Alice', position: 'P' },
    { id: 2, name: 'Bob',   position: 'SS' },
  ],
});

// Read the whole document
const roster = await store.get(K('roster'));

// Read a sub-value using an RFC 6901 JSON Pointer — only fetches relevant nodes
const name = await store.get(K('roster'), P('/players/0/name')); // 'Alice'

// Apply an RFC 6902 patch without loading the full document
await store.patch(K('roster'), JSON.stringify([
  { op: 'replace', path: '/players/0/position', value: 'CF' },
  { op: 'add',     path: '/players/-',          value: { id: 3, name: 'Carol', position: '1B' } },
]));

// Cheap change detection — no tree nodes fetched
const hash = await store.getRootHash(K('roster'));
```

## API

### `new ProllyTreeStore(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `adapter` | `StorageAdapter` | required | Storage backend |
| `initialState` | `Partial<PartitionerState>` | — | Skip calibration; provide `chunkSize` directly |
| `calibrationTtlMs` | `number` | 7 days | How long a persisted calibration result is reused before re-measuring |
| `writeRetries` | `number` | `0` | Extra attempts on a failed `persistBlob` or `deleteBlob` before throwing |

### `put(key, value)` → `ContentHash`

Stores a full JSON document under `key`, replacing any existing value. Builds a Prolly tree, deduplicates chunks that already exist in the adapter, and deletes stale chunks from the previous version. Returns a chunk-size-independent content hash.

```typescript
const store = new ProllyTreeStore({ adapter, initialState: { chunkSize: 4096 } });
const K = ProllyTreeStore.asKey;

const hashA = await store.put(K('standings'), { wins: 10, losses: 3 });
const hashB = await store.put(K('standings'), { wins: 10, losses: 3 }); // same doc
console.log(hashA === hashB); // true — hash is content-addressed
```

### `get(key, pointer?)` → `JSONValue`

Retrieves a document or sub-value. `pointer` is an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointer. Without a pointer the full document is returned. With a pointer, only the nodes on the path to that value are fetched — O(log n + result size).

```typescript
const K = ProllyTreeStore.asKey;
const P = ProllyTreeStore.asPointer;

await store.put(K('game'), { inning: 7, score: { home: 4, away: 2 }, outs: 2 });

const full  = await store.get(K('game'));                   // full document
const score = await store.get(K('game'), P('/score'));      // { home: 4, away: 2 }
const home  = await store.get(K('game'), P('/score/home')); // 4
```

### `patch(key, patches)` → `ContentHash`

Applies an [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) JSON Patch document without loading the full document. Mutations are routed directly to the affected leaf nodes; entry hashes are propagated up using XOR so sibling nodes are never fetched. `test` ops are evaluated via partial reads before any write — if any test fails, the document is left unchanged and `PatchTestFailedError` is thrown.

```typescript
const K = ProllyTreeStore.asKey;

await store.put(K('game'), { inning: 1, score: { home: 0, away: 0 }, outs: 0 });

// test + replace — atomic: document unchanged if the test op fails
await store.patch(K('game'), JSON.stringify([
  { op: 'test',    path: '/inning',     value: 1 },
  { op: 'replace', path: '/inning',     value: 2 },
  { op: 'replace', path: '/score/home', value: 3 },
]));

// add and remove
await store.patch(K('game'), JSON.stringify([
  { op: 'add',    path: '/weather', value: 'sunny' },
  { op: 'remove', path: '/outs' },
]));
```

### `diff(keyA, keyB)` → `JSONPatchDocument`

Produces an [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) patch that transforms the document at `keyA` into the document at `keyB`. Walks both trees simultaneously, pruning any subtrees whose entry hashes match. Returns `'[]'` immediately if the root hashes are equal.

```typescript
const K = ProllyTreeStore.asKey;

await store.put(K('v1'), { inning: 1, score: { home: 0, away: 0 } });
await store.put(K('v2'), { inning: 2, score: { home: 3, away: 0 } });

const patch = await store.diff(K('v1'), K('v2'));
// '[{"op":"replace","path":"/inning","value":2},{"op":"replace","path":"/score/home","value":3}]'

// Apply the diff to reproduce v2 from v1
await store.patch(K('v1'), patch);
console.log(await store.getRootHash(K('v1')) === await store.getRootHash(K('v2'))); // true
```

### `getRootHash(key)` → `ContentHash`

Returns the chunk-size-independent entry hash without fetching any tree nodes. Useful for cheap change detection and sync decisions.

```typescript
const K = ProllyTreeStore.asKey;

const before = await store.getRootHash(K('game'));
await store.patch(K('game'), JSON.stringify([{ op: 'replace', path: '/inning', value: 9 }]));
const after = await store.getRootHash(K('game'));

console.log(before === after); // false
```

### `delete(key)` → `void`

Removes the document and all its chunk blobs. No-op if the key does not exist.

### `calibrate()` → `PartitionerState`

Measures adapter latency and derives optimal `chunkSize` / `prefetchWidth`, then persists the result to the adapter so future instances can reuse it.

**When calibration runs:** lazily, on the first call to `put` or `patch`. Before measuring, it checks whether the adapter already has a valid calibration result written by a previous instance within `calibrationTtlMs`. If so, that result is reused with no I/O probes. `get`, `getRootHash`, and `diff` never trigger calibration.

**To skip calibration entirely:** pass `initialState: { chunkSize: N }`. Recommended for tests and any environment where the chunk size is known up front.

You can also call `calibrate()` manually to force a fresh measurement.

```typescript
// Skip calibration — chunk size is fixed
const store = new ProllyTreeStore({
  adapter,
  initialState: { chunkSize: 4096 },
});

// Force a fresh measurement
const state = await store.calibrate();
console.log(state.chunkSize, state.detectedBackend);
```

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

Because chunk keys are content-addressed, `persistBlob` is idempotent — writing the same chunk twice is safe. The library uses `readBlobs` (if provided) to batch-check which chunks already exist before writing, avoiding redundant writes. If your adapter has transient failure modes, use `writeRetries` to automatically retry failed `persistBlob` and `deleteBlob` calls.

## Running tests

```bash
npm test                                    # all tests with coverage
npx vitest run test/chaos.test.ts           # chaos / fuzz test (~5s)
```

## Design notes

**entryHash vs chunkHash** — Each node carries two hashes. `chunkHash` is the BLAKE3 of the node's serialized bytes and is used for content-addressing blobs. `entryHash` is an XOR-folded BLAKE3 over all descendant leaf `(key, value)` pairs; it is the same for the same document regardless of chunk size. `getRootHash` returns the `entryHash`; structural sharing checks use `chunkHash`.

**Prolly boundaries** — Chunk splits are determined by `rollingHash(key) mod fanout`, where `fanout = chunkSize / AVG_ENTRY_SIZE`. Because boundaries depend only on keys (not values), updating a value never changes tree structure. Insert/delete may change structure near the modified key, but the `put` function always rebuilds from the correct canonical form.

**Concurrency** — Chunk writes are safe to race (content-addressed, idempotent). Root pointer writes are last-writer-wins. For strong concurrency guarantees, the `StorageAdapter` should use conditional writes on root pointer keys.
