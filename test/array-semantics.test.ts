/**
 * Regression tests for RFC 6902 array semantics and container-shape handling.
 *
 * Every case in the first block is a bug found by auditing v1.0.2: the stored
 * flat keyspace could not tell an array from an object, and `patch` wrote array
 * indices positionally with no shifting, so inserts overwrote their neighbours
 * and removals left holes that only the full-document read papered over.
 */

import { describe, test, expect } from 'vitest';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { UnsupportedPatchOperationError, PatchTestFailedError } from '../src/errors.js';
import type { JSONValue } from '../src/types.js';

const K = (s: string) => ProllyTreeStore.asKey(s);
const P = (s: string) => ProllyTreeStore.asPointer(s);

function makeStore(chunkSize = 4096) {
  const adapter = new MemoryStorageAdapter();
  const store = new ProllyTreeStore({
    adapter,
    initialState: { chunkSize } as never,
  });
  return { adapter, store };
}

const patchOps = (ops: unknown[]) => JSON.stringify(ops) as never;

/** The canonical-form invariant: content alone determines the root hash. */
async function expectCanonical(
  store: ProllyTreeStore,
  key: ReturnType<typeof K>
): Promise<JSONValue> {
  const value = await store.get(key);
  const probe = K(`canonical-probe-${Math.random().toString(36).slice(2)}`);
  await store.put(probe, JSON.parse(JSON.stringify(value)));
  expect(await store.getRootHash(key)).toBe(await store.getRootHash(probe));
  await store.delete(probe);
  return value;
}

describe('audit regressions', () => {
  test('add /players/- appends instead of creating a "-" key', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { players: [{ id: 1 }, { id: 2 }] });

    await store.patch(K('d'), patchOps([{ op: 'add', path: '/players/-', value: { id: 3 } }]));

    expect(await store.get(K('d'))).toEqual({ players: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    await expectCanonical(store, K('d'));
  });

  test('add at an index shifts neighbours instead of overwriting them', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { p: ['a', 'b', 'c'] });

    await store.patch(K('d'), patchOps([{ op: 'add', path: '/p/1', value: 'X' }]));

    expect(await store.get(K('d'))).toEqual({ p: ['a', 'X', 'b', 'c'] });
    await expectCanonical(store, K('d'));
  });

  test('remove reindexes, and partial reads agree with the full read', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { p: ['a', 'b', 'c'] });

    await store.patch(K('d'), patchOps([{ op: 'remove', path: '/p/0' }]));

    expect(await store.get(K('d'))).toEqual({ p: ['b', 'c'] });
    expect(await store.get(K('d'), P('/p/0'))).toBe('b');
    expect(await store.get(K('d'), P('/p/1'))).toBe('c');
    await expectCanonical(store, K('d'));
  });

  test('a document patched to the same content has the same hash as a fresh put', async () => {
    const { store } = makeStore();
    await store.put(K('a'), { p: ['x', 'y', 'z'] });
    await store.patch(K('a'), patchOps([{ op: 'remove', path: '/p/0' }]));
    await store.put(K('b'), { p: ['y', 'z'] });

    expect(await store.getRootHash(K('a'))).toBe(await store.getRootHash(K('b')));
    expect(await store.diff(K('a'), K('b'))).toBe('[]');
  });

  test('object keys that look like array indices stay object keys', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { byId: { '3': { n: 'x' }, '7': { n: 'y' } } });

    expect(await store.get(K('d'), P('/byId/3'))).toEqual({ n: 'x' });

    await store.patch(K('d'), patchOps([{ op: 'replace', path: '/byId/3/n', value: 'CHANGED' }]));

    expect(await store.get(K('d'))).toEqual({ byId: { '3': { n: 'CHANGED' }, '7': { n: 'y' } } });
    await expectCanonical(store, K('d'));
  });

  test('object keys that are padded-width numbers are not read back as an array', async () => {
    const { store } = makeStore();
    const doc = { byId: { '0000000000': 'a', '0000000001': 'b' } };
    await store.put(K('d'), doc);

    expect(await store.get(K('d'))).toEqual(doc);
    expect(await store.get(K('d'), P('/byId/0000000000'))).toBe('a');
  });

  test('object keys needing RFC 6901 escapes are addressable', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { 'a/b': 1, 'c~d': 2 });

    expect(await store.get(K('d'), P('/a~1b'))).toBe(1);
    expect(await store.get(K('d'), P('/c~0d'))).toBe(2);

    await store.patch(K('d'), patchOps([{ op: 'replace', path: '/a~1b', value: 9 }]));
    expect(await store.get(K('d'))).toEqual({ 'a/b': 9, 'c~d': 2 });
  });

  test('move, copy and unknown ops are no longer silent no-ops', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { a: 1, b: 2 });

    await store.patch(K('d'), patchOps([{ op: 'move', from: '/a', path: '/c' }]));
    expect(await store.get(K('d'))).toEqual({ b: 2, c: 1 });

    await store.patch(K('d'), patchOps([{ op: 'copy', from: '/b', path: '/d' }]));
    expect(await store.get(K('d'))).toEqual({ b: 2, c: 1, d: 2 });

    await expect(
      store.patch(K('d'), patchOps([{ op: 'frobnicate', path: '/b', value: 1 }]))
    ).rejects.toThrow(UnsupportedPatchOperationError);
    expect(await store.get(K('d'))).toEqual({ b: 2, c: 1, d: 2 });
  });

  test('a test op compares values, not key order', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { outer: { b: 1, a: 2 } });

    // Written in a different member order than the tree returns.
    await store.patch(
      K('d'),
      patchOps([
        { op: 'test', path: '/outer', value: { a: 2, b: 1 } },
        { op: 'replace', path: '/outer/a', value: 3 },
      ])
    );

    expect(await store.get(K('d'))).toEqual({ outer: { b: 1, a: 3 } });
  });
});

describe('array inserts and removals', () => {
  const base = () => ({ xs: [0, 1, 2, 3] });

  const cases: Array<[string, unknown[], JSONValue]> = [
    ['insert at 0', [{ op: 'add', path: '/xs/0', value: 'n' }], { xs: ['n', 0, 1, 2, 3] }],
    ['insert in the middle', [{ op: 'add', path: '/xs/2', value: 'n' }], { xs: [0, 1, 'n', 2, 3] }],
    ['insert at the end index', [{ op: 'add', path: '/xs/4', value: 'n' }], { xs: [0, 1, 2, 3, 'n'] }],
    ['append with -', [{ op: 'add', path: '/xs/-', value: 'n' }], { xs: [0, 1, 2, 3, 'n'] }],
    ['remove first', [{ op: 'remove', path: '/xs/0' }], { xs: [1, 2, 3] }],
    ['remove middle', [{ op: 'remove', path: '/xs/2' }], { xs: [0, 1, 3] }],
    ['remove last', [{ op: 'remove', path: '/xs/3' }], { xs: [0, 1, 2] }],
    [
      'remove every element',
      [0, 1, 2, 3].map(() => ({ op: 'remove', path: '/xs/0' })),
      { xs: [] },
    ],
    [
      'several appends in one patch apply sequentially',
      [
        { op: 'add', path: '/xs/-', value: 'a' },
        { op: 'add', path: '/xs/-', value: 'b' },
      ],
      { xs: [0, 1, 2, 3, 'a', 'b'] },
    ],
    [
      'insert then remove earlier index',
      [
        { op: 'add', path: '/xs/1', value: 'n' },
        { op: 'remove', path: '/xs/0' },
      ],
      { xs: ['n', 1, 2, 3] },
    ],
    [
      'move within an array',
      [{ op: 'move', from: '/xs/0', path: '/xs/-' }],
      { xs: [1, 2, 3, 0] },
    ],
  ];

  for (const [label, ops, expected] of cases) {
    test(label, async () => {
      const { store } = makeStore();
      await store.put(K('d'), base());
      await store.patch(K('d'), patchOps(ops));
      expect(await store.get(K('d'))).toEqual(expected);
      await expectCanonical(store, K('d'));
    });
  }

  test('elements carrying subtrees are renumbered whole', async () => {
    const { store } = makeStore(256);
    await store.put(K('d'), {
      roster: [
        { name: 'a', stats: { h: 1, ab: 2 } },
        { name: 'b', stats: { h: 3, ab: 4 } },
        { name: 'c', stats: { h: 5, ab: 6 } },
      ],
    });

    await store.patch(K('d'), patchOps([{ op: 'remove', path: '/roster/0' }]));

    expect(await store.get(K('d'))).toEqual({
      roster: [
        { name: 'b', stats: { h: 3, ab: 4 } },
        { name: 'c', stats: { h: 5, ab: 6 } },
      ],
    });
    expect(await store.get(K('d'), P('/roster/0/stats/h'))).toBe(3);
    await expectCanonical(store, K('d'));
  });

  test('nested arrays shift independently', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { grid: [[1, 2], [3, 4]] });

    await store.patch(
      K('d'),
      patchOps([
        { op: 'add', path: '/grid/0/0', value: 0 },
        { op: 'remove', path: '/grid/1/1' },
      ])
    );

    expect(await store.get(K('d'))).toEqual({ grid: [[0, 1, 2], [3]] });
    await expectCanonical(store, K('d'));
  });

  test('out-of-range indices are rejected atomically', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { xs: [0, 1] });
    const before = await store.getRootHash(K('d'));

    for (const ops of [
      [{ op: 'add', path: '/xs/5', value: 'n' }],
      [{ op: 'remove', path: '/xs/2' }],
      [{ op: 'replace', path: '/xs/2', value: 'n' }],
      [{ op: 'replace', path: '/xs/-', value: 'n' }],
      [{ op: 'add', path: '/xs/notanindex', value: 'n' }],
      [{ op: 'remove', path: '/xs/-' }],
    ]) {
      await expect(store.patch(K('d'), patchOps(ops))).rejects.toThrow(
        UnsupportedPatchOperationError
      );
      expect(await store.get(K('d'))).toEqual({ xs: [0, 1] });
      expect(await store.getRootHash(K('d'))).toBe(before);
    }
  });

  test('a failing test op leaves the document untouched', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { xs: [0, 1], keep: true });
    const before = await store.getRootHash(K('d'));

    await expect(
      store.patch(
        K('d'),
        patchOps([
          { op: 'add', path: '/xs/-', value: 2 },
          { op: 'test', path: '/keep', value: false },
        ])
      )
    ).rejects.toThrow(PatchTestFailedError);

    expect(await store.get(K('d'))).toEqual({ xs: [0, 1], keep: true });
    expect(await store.getRootHash(K('d'))).toBe(before);
  });
});

describe('container shape', () => {
  test('arrays and objects with the same members hash differently', async () => {
    const { store } = makeStore();
    await store.put(K('arr'), { v: ['a', 'b'] });
    await store.put(K('obj'), { v: { '0': 'a', '1': 'b' } });

    expect(await store.getRootHash(K('arr'))).not.toBe(await store.getRootHash(K('obj')));
    expect(await store.get(K('arr'))).toEqual({ v: ['a', 'b'] });
    expect(await store.get(K('obj'))).toEqual({ v: { '0': 'a', '1': 'b' } });
  });

  test('diff expresses an array becoming an object', async () => {
    const { store } = makeStore();
    await store.put(K('a'), { v: ['a', 'b'] });
    await store.put(K('b'), { v: { x: 1 } });

    await store.patch(K('a'), await store.diff(K('a'), K('b')));

    expect(await store.get(K('a'))).toEqual({ v: { x: 1 } });
    expect(await store.getRootHash(K('a'))).toBe(await store.getRootHash(K('b')));
  });

  test('diff expresses a container becoming a scalar', async () => {
    const { store } = makeStore();
    await store.put(K('a'), { v: [{ deep: 1 }], w: { k: 2 } });
    await store.put(K('b'), { v: 'scalar', w: 3 });

    await store.patch(K('a'), await store.diff(K('a'), K('b')));

    expect(await store.get(K('a'))).toEqual({ v: 'scalar', w: 3 });
    expect(await store.getRootHash(K('a'))).toBe(await store.getRootHash(K('b')));
  });

  test('empty containers round-trip and keep their shape', async () => {
    const { store } = makeStore();
    const doc = { emptyArr: [], emptyObj: {}, nested: { a: [], b: {} } };
    await store.put(K('d'), doc);

    expect(await store.get(K('d'))).toEqual(doc);
    expect(await store.get(K('d'), P('/emptyArr'))).toEqual([]);
    expect(await store.get(K('d'), P('/emptyObj'))).toEqual({});

    await store.patch(K('d'), patchOps([{ op: 'add', path: '/emptyArr/-', value: 1 }]));
    expect(await store.get(K('d'), P('/emptyArr'))).toEqual([1]);
    await expectCanonical(store, K('d'));
  });

  test('adding into an empty object replaces its stored leaf', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { meta: {} });

    await store.patch(K('d'), patchOps([{ op: 'add', path: '/meta/k', value: 1 }]));

    expect(await store.get(K('d'))).toEqual({ meta: { k: 1 } });
    await expectCanonical(store, K('d'));
  });

  test('emptying an object restores the canonical empty form', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { meta: { k: 1 }, other: 2 });

    await store.patch(K('d'), patchOps([{ op: 'remove', path: '/meta/k' }]));

    expect(await store.get(K('d'))).toEqual({ meta: {}, other: 2 });
    await expectCanonical(store, K('d'));
  });

  test('patching a document down to empty matches a put of {}', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { only: 1 });
    await store.put(K('empty'), {});

    await store.patch(K('d'), patchOps([{ op: 'remove', path: '/only' }]));

    expect(await store.get(K('d'))).toEqual({});
    expect(await store.getRootHash(K('d'))).toBe(await store.getRootHash(K('empty')));
  });

  test('writing a member into a scalar is rejected', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { scalar: 5 });

    await expect(
      store.patch(K('d'), patchOps([{ op: 'add', path: '/scalar/k', value: 1 }]))
    ).rejects.toThrow(UnsupportedPatchOperationError);
    expect(await store.get(K('d'))).toEqual({ scalar: 5 });
  });

  test('the document root cannot be removed by patch', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { a: 1 });

    await expect(store.patch(K('d'), patchOps([{ op: 'remove', path: '' }]))).rejects.toThrow(
      /delete\(key\)/
    );
    expect(await store.get(K('d'))).toEqual({ a: 1 });
  });

  test('a value cannot be moved into its own descendant', async () => {
    const { store } = makeStore();
    await store.put(K('d'), { a: { b: 1 } });

    await expect(
      store.patch(K('d'), patchOps([{ op: 'move', from: '/a', path: '/a/b/c' }]))
    ).rejects.toThrow(UnsupportedPatchOperationError);
    await expect(
      store.patch(K('d'), patchOps([{ op: 'move', from: '', path: '/a/b' }]))
    ).rejects.toThrow(UnsupportedPatchOperationError);
    expect(await store.get(K('d'))).toEqual({ a: { b: 1 } });
  });

  test('top-level arrays and scalars are supported', async () => {
    const { store } = makeStore();

    await store.put(K('arr'), [1, 2, 3] as never);
    expect(await store.get(K('arr'))).toEqual([1, 2, 3]);
    await store.patch(K('arr'), patchOps([{ op: 'add', path: '/0', value: 0 }]));
    expect(await store.get(K('arr'))).toEqual([0, 1, 2, 3]);
    await expectCanonical(store, K('arr'));

    await store.put(K('scalar'), 'just-a-string' as never);
    expect(await store.get(K('scalar'))).toBe('just-a-string');
    await store.patch(K('scalar'), patchOps([{ op: 'replace', path: '', value: 42 }]));
    expect(await store.get(K('scalar'))).toBe(42);
  });
});
