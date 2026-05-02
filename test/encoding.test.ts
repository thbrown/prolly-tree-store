import { describe, test, expect } from 'vitest';
import {
  pointerToTreeKey,
  treeKeyToPointer,
  flattenDocument,
  unflattenEntries,
} from '../src/encoding.js';

describe('pointerToTreeKey', () => {
  test('empty pointer returns empty string', () => {
    expect(pointerToTreeKey('')).toBe('');
  });

  test('root pointer "/" returns empty string', () => {
    expect(pointerToTreeKey('/')).toBe('');
  });

  test('simple path', () => {
    expect(pointerToTreeKey('/foo')).toBe('foo');
  });

  test('nested path', () => {
    expect(pointerToTreeKey('/players/stats/era')).toBe('players\x00stats\x00era');
  });

  test('integer segment is zero-padded to 10 digits', () => {
    expect(pointerToTreeKey('/players/3/name')).toBe('players\x000000000003\x00name');
  });

  test('large integer segment padded correctly', () => {
    expect(pointerToTreeKey('/items/123')).toBe('items\x000000000123');
  });

  test('RFC 6901 ~1 escape unescaped before encoding', () => {
    expect(pointerToTreeKey('/a~1b')).toBe('a/b');
  });

  test('RFC 6901 ~0 escape unescaped before encoding', () => {
    expect(pointerToTreeKey('/a~0b')).toBe('a~b');
  });
});

describe('treeKeyToPointer', () => {
  test('empty string returns empty pointer', () => {
    expect(treeKeyToPointer('')).toBe('');
  });

  test('simple key', () => {
    expect(treeKeyToPointer('foo')).toBe('/foo');
  });

  test('nested key', () => {
    expect(treeKeyToPointer('players\x00stats\x00era')).toBe('/players/stats/era');
  });

  test('numeric segment strips leading zeros', () => {
    expect(treeKeyToPointer('players\x000000000003\x00name')).toBe('/players/3/name');
  });

  test('RFC 6901 ~ escaped in output', () => {
    expect(treeKeyToPointer('a~b')).toBe('/a~0b');
  });

  test('RFC 6901 / escaped in output', () => {
    expect(treeKeyToPointer('a/b')).toBe('/a~1b');
  });
});

describe('pointer ↔ treeKey roundtrip', () => {
  const cases = [
    '/foo/bar/baz',
    '/players/0/name',
    '/players/42/stats/era',
    '/a~0b',
    '/a~1b',
  ];
  for (const pointer of cases) {
    test(`roundtrip: ${pointer}`, () => {
      expect(treeKeyToPointer(pointerToTreeKey(pointer))).toBe(pointer);
    });
  }
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

  test('array values use padded integer keys', () => {
    const flat = flattenDocument({ items: [10, 20, 30] });
    expect(flat.get('items\x000000000000')).toBe(10);
    expect(flat.get('items\x000000000001')).toBe(20);
    expect(flat.get('items\x000000000002')).toBe(30);
  });

  test('empty array emitted as leaf', () => {
    const flat = flattenDocument({ items: [] });
    expect(flat.get('items')).toEqual([]);
  });

  test('empty object emitted as leaf', () => {
    const flat = flattenDocument({ meta: {} });
    expect(flat.get('meta')).toEqual({});
  });

  test('null value', () => {
    const flat = flattenDocument({ x: null });
    expect(flat.get('x')).toBeNull();
  });

  test('boolean value', () => {
    const flat = flattenDocument({ flag: true });
    expect(flat.get('flag')).toBe(true);
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
  ];

  for (const [label, doc] of cases) {
    test(label, () => {
      const flat = flattenDocument(doc as any);
      const entries = [...flat.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const result = unflattenEntries(entries);
      expect(result).toEqual(doc);
    });
  }
});
