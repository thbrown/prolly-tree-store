# prolly-tree-store

Store a large JSON document as a Merkle [Prolly tree](https://docs.dolthub.com/architecture/storage-engine/prolly-tree) so that two stores which share nothing but hashes can work out what changed between them, and move only that.

Built for keeping one document in sync across storage with wildly different costs — IndexedDB in a browser, a bucket in the cloud — where a read is cheap on one side and expensive on the other.

<img src="https://raw.githubusercontent.com/thbrown/prolly-tree-store/master/docs/images/sync.gif" alt="Two stores holding the same document. A value changes in the browser, the new hash propagates to the root, the cloud compares one root hash, the lockstep walk prunes every matching subtree, and only the changed chunks move." width="760">

```bash
npm install prolly-tree-store
```

Node 18+ and modern browsers. No Node-specific APIs; anything with `performance.now()` and ESM works.

## What it gives you

- **Change detection for one small read.** `getRootHash` fetches a single pointer blob and no tree nodes.
- **Diffs proportional to what changed**, not to document size. Identical subtrees are pruned on one hash comparison.
- **Patches that touch only the path to the leaf.** On a 220-player roster (84 chunks), changing one stat reads 6 blobs and writes 4; rebuilding the document reads 85.
- **Chunk-size independence.** The same document chunked at 4 KB and at 64 KB produces different trees and the *same* `entryHash`, so stores tuned differently remain comparable.
- **RFC 6902 patches and RFC 6901 pointers**, with real array semantics — inserts shift, removals reindex.
- **Content-addressed chunks**, so writes are idempotent and safe to race.

## Quick start

```typescript
import { ProllyTreeStore, MemoryStorageAdapter } from 'prolly-tree-store';

const store = new ProllyTreeStore({ adapter: new MemoryStorageAdapter() });

const K = ProllyTreeStore.asKey;
const P = ProllyTreeStore.asPointer;

await store.put(K('roster'), {
  team: 'Red Sox',
  players: [
    { id: 1, name: 'Alice', position: 'P' },
    { id: 2, name: 'Bob', position: 'SS' },
  ],
});

// Whole document, or a sub-value — a pointer read fetches only the nodes on the way
const roster = await store.get(K('roster'));
const name = await store.get(K('roster'), P('/players/0/name')); // 'Alice'

// Mutate without loading the document
await store.patch(K('roster'), JSON.stringify([
  { op: 'replace', path: '/players/0/position', value: 'CF' },
  { op: 'add', path: '/players/-', value: { id: 3, name: 'Carol', position: '1B' } },
]));

// Cheap change detection — no tree nodes fetched
const hash = await store.getRootHash(K('roster'));
```

## Syncing two stores

The whole design exists to make this loop cheap. The two sides need not agree on chunk size, or have ever read each other's trees.

`diff` compares two documents **within one store**, so the pattern is to keep a snapshot of the last agreed state and diff against that. The patch it produces is ordinary RFC 6902 — it travels to the other side as JSON and applies there.

```typescript
const DOC = K('roster');
const SYNCED = K('roster@synced');   // what we last agreed on with the remote

// One pointer read each. Nothing to do in the common case.
if (await local.getRootHash(DOC) === await remote.getRootHash(DOC)) return;

// What changed on our side since the last agreement
const outgoing = await local.diff(SYNCED, DOC);

await remote.patch(DOC, outgoing);
await local.put(SYNCED, await local.get(DOC));
```

`diff` returns `'[]'` as soon as the two root hashes agree, so an unchanged document costs two pointer reads and nothing else.

A snapshot key stores its own copy of the chunks, since chunk keys are per-document (see [Writing a StorageAdapter](#writing-a-storageadapter)). If both sides can change, you need the usual conflict handling on top of this — the library tells you *that* and *what* differs, not whose version wins.

### Why different chunk sizes still compare

<img src="https://raw.githubusercontent.com/thbrown/prolly-tree-store/master/docs/images/chunk-size.gif" alt="The same document chunked at 4 KB and at 64 KB produces 84 chunks and 9 chunks respectively, with different chunk hashes but an identical entryHash." width="760">

Each node carries two hashes:

- **`chunkHash`** — BLAKE3 of the node's serialised bytes. It content-addresses the blob, and it necessarily differs when the chunking differs.
- **`entryHash`** — BLAKE3 of each `(key, value)` pair, XOR-folded together. XOR is commutative and associative, so the result does not depend on how entries were grouped into chunks.

`getRootHash` returns the `entryHash`. Structural sharing uses `chunkHash`. That split is what lets a browser tuned to 4 KB chunks and a bucket tuned to 64 KB chunks compare state directly.

## API

### `new ProllyTreeStore(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `adapter` | `StorageAdapter` | required | Storage backend |
| `initialState` | `Partial<PartitionerState>` | — | Skip calibration by supplying `chunkSize` |
| `calibrationTtlMs` | `number` | 7 days | How long a persisted calibration result is reused |
| `writeRetries` | `number` | `0` | Extra attempts on a failed write, for `RetryableStorageError` only |
| `retainStaleChunks` | `boolean` | `false` | Keep chunks a `put` replaced, for `gc()` to reclaim later |
| `encoder` / `decoder` | `(doc) => doc` | — | Document-level transform applied before storing / after reading |

### `put(key, value)` → `ContentHash`

Stores a whole document, replacing any existing value. Builds the tree, skips writing chunks that already exist, and deletes the previous version's chunks once the new root pointer is committed. Returns the chunk-size-independent `entryHash`.

### `get(key, pointer?)` → `JSONValue`

The whole document, or the value at an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) pointer. A pointer read walks only the subtree covering that key.

Pointers resolve against the *stored shape*: a numeric segment indexes an array only where an array is actually stored, so `{"byId": {"3": …}}` is addressable at `/byId/3` and is never mistaken for an array.

### `patch(key, patches)` → `ContentHash`

Applies an [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) patch without loading the document.

<img src="https://raw.githubusercontent.com/thbrown/prolly-tree-store/master/docs/images/patch.gif" alt="A patch descends one node per level to the target leaf, rewrites only the path back to the root, and reuses every other node." width="760">

Operations apply **in order**, each seeing the result of the one before, as RFC 6902 requires. Nothing is written until the whole list has been planned, so a rejected patch leaves the document untouched.

Arrays behave like arrays: `add` at an index shifts the elements after it, `add` to `/-` appends, and `remove` reindexes. `move` and `copy` are supported.

```typescript
await store.patch(K('game'), JSON.stringify([
  { op: 'test',    path: '/inning', value: 1 },   // checked first; fails atomically
  { op: 'replace', path: '/inning', value: 2 },
  { op: 'add',     path: '/lineup/0', value: 'Alice' }, // shifts the rest down
  { op: 'remove',  path: '/lineup/4' },                 // reindexes what follows
]));
```

The library is stricter than some RFC 6902 implementations. These throw, leaving the document unchanged:

| Rejected | Why |
|---|---|
| An array index out of range, or a non-index key under an array | Would leave a hole and break dense indexing |
| Adding a member to a scalar | RFC 6902 calls it an error; inventing a container would be a guess |
| `remove` on `""` | A document always has a root — use `delete(key)` |
| `move` into the moved value's own descendant | Forbidden by RFC 6902 |
| An unrecognised `op` | Silently ignoring it loses data |

### `diff(keyA, keyB)` → `JSONPatchDocument`

An RFC 6902 patch turning the document at `keyA` into the one at `keyB`. Walks both trees in lockstep, pruning any subtree pair whose hashes match. Returns `'[]'` immediately when the root hashes agree.

```typescript
const patch = await store.diff(K('v1'), K('v2'));
await store.patch(K('v1'), patch);
await store.getRootHash(K('v1')) === await store.getRootHash(K('v2')); // true
```

### `getRootHash(key)` → `ContentHash`

The chunk-size-independent `entryHash`, fetching only the root pointer blob.

### `delete(key)` → `void`

Removes the document and every chunk it owns. A no-op if the key does not exist.

### `compact(key)` → `ContentHash`

Rebuilds the document in canonical form. See [chunk layout drift](#chunk-layout-drift) for when you'd want it. Content and root hash are unchanged; only the chunk layout is.

### `gc(key)` → `number`

Deletes chunks under `key` that the current tree no longer references, returning how many went. Needs `listBlobs` on the adapter — an orphan is by definition unreachable from the root, so there is no other way to find one.

<img src="https://raw.githubusercontent.com/thbrown/prolly-tree-store/master/docs/images/delete-gc.gif" alt="delete walks the tree and removes every chunk the document owns. A write interrupted before the root pointer commits leaves unreachable chunks, which gc lists by prefix and removes." width="760">

Two things leave chunks behind: a write interrupted before its root pointer commits, and `retainStaleChunks`.

### `calibrate()` → `PartitionerState`

Measures adapter latency and derives a `chunkSize`, then persists the result so later instances reuse it. Runs lazily on the first `put` or `patch`; `get`, `getRootHash` and `diff` never trigger it.

A changed `chunkSize` never invalidates stored data — `get`, `diff` and `getRootHash` are chunk-size agnostic, and `patch` keeps a document's existing chunk size. Only `put` adopts a new one, and it rebuilds the whole document anyway.

**For tests and for any environment where you know the chunk size, pass `initialState: { chunkSize: N }` and skip it.** Calibration writes 4 KB, 64 KB and 512 KB probe blobs to measure read latency, which is real traffic against your bucket.

## Writing a StorageAdapter

```typescript
interface StorageAdapter {
  persistBlob(key: KeyString, value: JSONBlob): Promise<void>;
  readBlob(key: KeyString): Promise<JSONBlob>;      // throw BlobNotFoundError if missing
  deleteBlob(key: KeyString): Promise<void>;
  readBlobs?(keys: KeyString[]): Promise<Map<KeyString, JSONBlob>>; // batch read
  listBlobs?(prefix: string): Promise<KeyString[]>;                 // required by gc()
}
```

Values are opaque strings. Keys look like:

- `__root__/{documentKey}` — the root pointer, one small JSON blob per document
- `chunks/{documentKey}/{xx}/{64-char-hex}` — a tree node, base64-encoded msgpack, addressed by its BLAKE3 `chunkHash` and sharded by the first two hex characters

Chunk keys are **namespaced per document**. That is what makes `delete` and `gc` safe without reference counting: no other document can point at these chunks. The cost is that two documents holding identical content store it twice — there is no cross-document sharing.

Because chunk keys are content-addressed, `persistBlob` is idempotent and safe to race. Root pointer writes are last-writer-wins; use a conditional write on `__root__/` keys if you need better.

### Retryable vs fatal errors

With `writeRetries > 0`, failed writes are retried **only** when the adapter throws `RetryableStorageError`. Anything else is fatal and rethrown at once, so your adapter decides.

```typescript
class MyAdapter implements StorageAdapter {
  async persistBlob(key, value) {
    try {
      await backend.write(key, value);
    } catch (e) {
      if (isNetworkTimeout(e) || isRateLimit(e)) {
        throw new RetryableStorageError('transient write failure', e);
      }
      throw e; // permission denied, quota exceeded, invalid key
    }
  }

  async readBlob(key) {
    const value = await backend.read(key);
    if (value === null) throw new BlobNotFoundError(key);
    return value;
  }
}
```

## Errors

| Class | Thrown by | Meaning |
|---|---|---|
| `BlobNotFoundError` | adapter contract, pointer reads | A key that should exist is missing |
| `PatchTestFailedError` | `patch` | An RFC 6902 `test` op did not match; nothing was written |
| `UnsupportedPatchOperationError` | `patch` | An operation that cannot be applied — see the table above |
| `InvalidDocumentError` | `put`, `patch` | A document that cannot be represented (an object key containing a NUL byte) |
| `UnsupportedFormatError` | any read | The stored tree was written by an incompatible format version |
| `RetryableStorageError` | your adapter | A transient failure that is safe to retry |

## Design notes

**Keys.** A document is flattened to one entry per leaf value, with a NUL-delimited key: `{"players": [{"name": "Alice"}]}` becomes `players\0 0000000000\0 name`. Array indices are zero-padded so lexicographic order matches numeric order. Arrays also store a marker entry at their own key — encoded as a msgpack extension type, which no JSON value can produce — so container shape is recorded in the tree and contributes to `entryHash`. Without it, `["a","b"]` and `{"0":"a","1":"b"}` would be indistinguishable once flattened.

**Canonical form.** The stored entries for a document are always exactly `flatten(get(key))`: array indices dense, empty containers in their canonical shape. So `getRootHash` depends only on content, never on the sequence of edits that produced it — two stores that reach the same document by different routes agree, which is what sync rests on. A property test asserts this after every operation in a fuzz run.

**Boundaries.** Leaves close at content-defined boundaries: `rollingHash(key) mod fanout`, where `fanout = chunkSize / AVG_ENTRY_SIZE`. Because boundaries depend only on keys, updating a value never changes the tree's shape. Each level above groups on the *last* key of each child — the key that closed it — against a larger modulus, so the levels compose and the tree keeps a real branching factor.

**Chunk layout drift.** `patch` re-chunks the nodes it rewrites, so leaves split as they grow and emptied ones are dropped. Splitting is local; *merging* an undersized node would need its neighbour, which lives outside the node being rewritten. So a heavily patched document can end up with a different chunk layout from a fresh `put` of the same content. It costs nothing in correctness — `entryHash` ignores layout, so hashes still agree and `diff` still returns `'[]'` for equal content — but where layouts differ, `diff` falls back to comparing entries directly instead of pruning by hash. `compact(key)` restores the canonical layout.

**Concurrency.** Chunk writes race safely. A `put` deletes the previous version's chunks as soon as the new root pointer commits, which can strand a reader midway through the old tree; `retainStaleChunks` defers that, and `gc` reclaims later.

## Development

```bash
npm test                                   # full suite with coverage
npx vitest run test/chaos.test.ts          # property/fuzz run (~5s)
CHAOS_MS=60000 npx vitest run test/chaos.test.ts   # longer soak
```

The fuzz test generates patches at arbitrary depth, applies them to `fast-json-patch` as a reference implementation, and after every mutation asserts that the document matches, that its root hash equals a fresh `put` of the same content, and that every pointer read agrees with the full read.

The README animations are generated from the library's own measured behaviour — every number in them comes from running the built code:

```bash
npm run build
npm i -D @napi-rs/canvas   # one-off; needs ffmpeg on PATH
node tools/diagrams/measure.mjs   # print the measurements
npm run diagrams                  # render docs/images/*.gif
```

---

MIT. Written with [Claude Code](https://claude.ai/code).
