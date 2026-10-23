import { describe, test, expect } from 'vitest';
import {
  pointerSegments,
  treeKeyToPointer,
  flattenDocument,
  unflattenEntries,
  padIndex,
  isPaddedIndex,
  escapeSegment,
  unescapeSegment,
  relativeKey,
  joinKey,
  ancestorPrefixes,
  isUnderPrefix,
  prefixUpperBound,
} from '../src/encoding.js';
import { ARRAY_MARKER } from '../src/types.js';
import { InvalidDocumentError } from '../src/errors.js';
import type { StoredValue } from '../src/types.js';

const sortEntries = (flat: Map<string, StoredValue>): [string, StoredValue][] =>
  [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe('pointerSegments', () => {
  test('empty pointer has no segments', () => {
    expect(pointerSegments('')).toEqual([]);
  });

  test('root pointer has no segments', () => {
    expect(pointerSegments('/')).toEqual([]);
  });

  test('single segment', () => {
    expect(pointerSegments('/foo')).toEqual(['foo']);
  });

  test('nested segments', () => {
    expect(pointerSegments('/players/stats/era')).toEqual(['players', 'stats', 'era']);
  });

  test('numeric segments are NOT padded — shape is unknown here', () => {
    expect(pointerSegments('/players/3/name')).toEqual(['players', '3', 'name']);
  });

  test('segments stay in their escaped form, matching stored keys', () => {
    // flattenDocument stores the key "a/b" as the escaped segment "a~1b", so a
    // pointer segment must be comparable to it verbatim.
    expect(pointerSegments('/a~1b')).toEqual(['a~1b']);
    expect(pointerSegments('/a~0b')).toEqual(['a~0b']);
  });
});

describe('treeKeyToPointer', () => {
  test('empty key is the root pointer', () => {
    expect(treeKeyToPointer('')).toBe('');
  });

  test('single segment', () => {
    expect(treeKeyToPointer('foo')).toBe('/foo');
  });

  test('nested segments', () => {
    expect(treeKeyToPointer('players\x00stats\x00era')).toBe('/players/stats/era');
  });

  test('padded index decodes to a plain number', () => {
    expect(treeKeyToPointer('players\x000000000003\x00name')).toBe('/players/3/name');
  });

  test('stored escapes are emitted verbatim, not re-escaped', () => {
    // The stored segment for key "a/b" is "a~1b"; emitting "/a~01b" would be a
    // double-escape and would not resolve back to the same key.
    expect(treeKeyToPointer('a~1b')).toBe('/a~1b');
    expect(treeKeyToPointer('a~0b')).toBe('/a~0b');
  });
});

describe('pointer ↔ tree key roundtrip', () => {
  // Round-tripping through the stored form: segments of a pointer are exactly
  // the segments of the tree key, modulo index padding.
  const cases = ['/foo/bar/baz', '/a~0b', '/a~1b', '/0000000003'];

  for (const pointer of cases) {
    test(`roundtrip: ${pointer}`, () => {
      const treeKey = pointerSegments(pointer).join('\x00');
      expect(treeKeyToPointer(treeKey)).toBe(pointer === '/0000000003' ? '/3' : pointer);
    });
  }

  test('escaped object key survives flatten → pointer → segment', () => {
    const flat = flattenDocument({ 'a/b': 1 });
    const [storedKey] = [...flat.keys()];
    const pointer = treeKeyToPointer(storedKey);
    expect(pointer).toBe('/a~1b');
    expect(pointerSegments(pointer)).toEqual([storedKey]);
  });
});

describe('key helpers', () => {
  test('padIndex / isPaddedIndex', () => {
    expect(padIndex(3)).toBe('0000000003');
    expect(isPaddedIndex('0000000003')).toBe(true);
    expect(isPaddedIndex('3')).toBe(false);
    expect(isPaddedIndex('name')).toBe(false);
  });

  test('escape / unescape are inverses', () => {
    for (const key of ['plain', 'a/b', 'a~b', '~0', '~1', 'a~1b']) {
      expect(unescapeSegment(escapeSegment(key))).toBe(key);
    }
  });

  test('joinKey / relativeKey are inverses', () => {
    expect(joinKey('', 'a')).toBe('a');
    expect(joinKey('a', '')).toBe('a');
    expect(joinKey('a', 'b')).toBe('a\x00b');
    expect(relativeKey('a\x00b', 'a')).toBe('b');
    expect(relativeKey('a', 'a')).toBe('');
    expect(relativeKey('a\x00b', '')).toBe('a\x00b');
  });

  test('ancestorPrefixes lists containers outermost first, root included', () => {
    expect(ancestorPrefixes('a\x00b\x00c')).toEqual(['', 'a', 'a\x00b']);
    expect(ancestorPrefixes('a')).toEqual(['']);
    expect(ancestorPrefixes('')).toEqual([]);
  });

  test('isUnderPrefix matches the key itself and its descendants only', () => {
    expect(isUnderPrefix('a', 'a')).toBe(true);
    expect(isUnderPrefix('a\x00b', 'a')).toBe(true);
    expect(isUnderPrefix('ab', 'a')).toBe(false);
    expect(isUnderPrefix('anything', '')).toBe(true);
  });

  test('prefixUpperBound bounds every key under the prefix', () => {
    const bound = prefixUpperBound('a');
    expect('a' < bound).toBe(true);
    expect('a\x00b' < bound).toBe(true);
    expect('a\x00￿' < bound).toBe(true);
    expect('ab' < bound).toBe(false);
  });
});

describe('flattenDocument', () => {
  test('flat object', () => {
    const flat = flattenDocument({ a: 1, b: 'x' });
    expect(flat.get('a')).toBe(1);
    expect(flat.get('b')).toBe('x');
    expect(flat.size).toBe(2);
  });

  test('nested object', () => {
    const flat = flattenDocument({ a: { b: { c: 42 } } });
    expect(flat.get('a\x00b\x00c')).toBe(42);
    expect(flat.size).toBe(1);
  });

  test('array values use padded integer keys plus a marker', () => {
    const flat = flattenDocument({ items: [10, 20, 30] });
    expect(flat.get('items')).toBe(ARRAY_MARKER);
    expect(flat.get('items\x000000000000')).toBe(10);
    expect(flat.get('items\x000000000001')).toBe(20);
    expect(flat.get('items\x000000000002')).toBe(30);
    expect(flat.size).toBe(4);
  });

  test('empty array is the marker alone', () => {
    const flat = flattenDocument({ items: [] });
    expect(flat.get('items')).toBe(ARRAY_MARKER);
    expect(flat.size).toBe(1);
  });

  test('empty object emitted as leaf', () => {
    const flat = flattenDocument({ meta: {} });
    expect(flat.get('meta')).toEqual({});
  });

  test('objects are not marked, even with all-numeric keys', () => {
    const flat = flattenDocument({ byId: { '0000000000': 'a' } });
    expect(flat.get('byId')).toBeUndefined();
    expect(flat.get('byId\x000000000000')).toBe('a');
  });

  test('null value', () => {
    const flat = flattenDocument({ x: null });
    expect(flat.get('x')).toBeNull();
  });

  test('boolean value', () => {
    const flat = flattenDocument({ flag: true });
    expect(flat.get('flag')).toBe(true);
  });

  test('a prefix writes keys beneath it', () => {
    const flat = flattenDocument({ a: 1 }, 'root\x00sub');
    expect(flat.get('root\x00sub\x00a')).toBe(1);
  });

  test('object keys containing NUL are rejected', () => {
    expect(() => flattenDocument({ 'a\x00b': 1 })).toThrow(InvalidDocumentError);
    expect(() => flattenDocument({ outer: { 'a\x00b': 1 } })).toThrow(/outer/);
  });
});

describe('unflattenEntries roundtrip', () => {
  const cases: [string, unknown][] = [
    ['flat object', { a: 1, b: 'hello', c: true }],
    ['nested object', { x: { y: { z: 99 } } }],
    ['array in object', { items: [1, 2, 3] }],
    ['null value', { a: null }],
    ['empty array', { items: [] }],
    ['empty object', { meta: {} }],
    ['mixed nested', { players: [{ name: 'Alice', score: 10 }, { name: 'Bob', score: 20 }] }],
    ['top-level array', [1, 2, 3]],
    ['nested arrays', { grid: [[1, 2], [3]] }],
    ['array of empty containers', { xs: [[], {}] }],
    // These are the cases the old all-numeric-heads heuristic got wrong.
    ['object with numeric-string keys', { byId: { '3': 'a', '7': 'b' } }],
    ['object with padded-numeric keys', { byId: { '0000000003': 'a' } }],
    ['object keys needing escapes', { 'a/b': 1, 'a~b': 2 }],
  ];

  for (const [label, doc] of cases) {
    test(label, () => {
      expect(unflattenEntries(sortEntries(flattenDocument(doc as never)))).toEqual(doc);
    });
  }

  test('no entries is an empty object', () => {
    expect(unflattenEntries([])).toEqual({});
  });
});
