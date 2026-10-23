import { describe, test, expect } from 'vitest';
import {
  isBoundary,
  rollingHash,
  groupLeafEntries,
  groupChildren,
  makeLeaf,
  buildTree,
  fanoutFor,
} from '../src/prolly.js';
import type { Child } from '../src/prolly.js';
import { entryHashOf, combineEntryHashes, entryHashToContentHash } from '../src/hashing.js';
import { encodeValue, decodeNode } from '../src/serialization.js';

describe('rollingHash', () => {
  test('same input → same output', () => {
    expect(rollingHash('hello')).toBe(rollingHash('hello'));
  });

  test('different input → different output (likely)', () => {
    expect(rollingHash('hello')).not.toBe(rollingHash('world'));
  });

  test('returns unsigned 32-bit integer', () => {
    const h = rollingHash('test-key');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('isBoundary', () => {
  test('deterministic for same key/level/chunkSize', () => {
    const a = isBoundary('some-key', 1, 4096);
    const b = isBoundary('some-key', 1, 4096);
    expect(a).toBe(b);
  });

  test('larger chunkSize → fewer boundaries (statistically)', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `key-${i}`);
    const smallBoundaries = keys.filter(k => isBoundary(k, 1, 128)).length;
    const largeBoundaries = keys.filter(k => isBoundary(k, 1, 4096)).length;
    expect(smallBoundaries).toBeGreaterThan(largeBoundaries);
  });
});

const leafEntry = (key: string, value: unknown) => ({ key, valueMsgpack: encodeValue(value as never) });

describe('groupLeafEntries', () => {
  test('no entries → no groups', () => {
    expect(groupLeafEntries([], 4096)).toEqual([]);
  });

  test('single entry → one group', () => {
    const groups = groupLeafEntries([leafEntry('a', 1)], 4096);
    expect(groups).toHaveLength(1);
    expect(groups[0][0].key).toBe('a');
  });

  test('every entry lands in exactly one group, in order', () => {
    const entries = Array.from({ length: 200 }, (_, i) => leafEntry(`key-${String(i).padStart(4, '0')}`, i));
    const groups = groupLeafEntries(entries, 128);

    expect(groups.flat().map(e => e.key)).toEqual(entries.map(e => e.key));
    expect(groups.length).toBeGreaterThan(1);
  });

  test('a leaf built from a group reports its last key', () => {
    const built = makeLeaf([leafEntry('a', 1), leafEntry('b', 2)]);
    expect(built.child.lastKey).toBe('b');
    expect(built.node.chunkHash).toHaveLength(32);
  });
});

describe('groupChildren', () => {
  const child = (lastKey: string): Child => ({
    chunkHash: new Uint8Array(32),
    entryHash: new Uint8Array(32),
    lastKey,
  });

  test('groups on last keys, which are the keys that closed each chunk', () => {
    // A chunk closes exactly at a boundary key, so a child's last key is a
    // boundary one level down. Grouping on first keys would never split a level.
    const chunkSize = 256;
    const fanout = fanoutFor(chunkSize);
    const keys = Array.from({ length: 4000 }, (_, i) => `roster\u0000${String(i).padStart(10, '0')}\u0000name`);

    const closing = keys.filter(key => isBoundary(key, 1, chunkSize));
    expect(closing.length).toBeGreaterThan(10);

    // Those same keys close a group one level up roughly 1/fanout of the time,
    // which is what keeps the tree shrinking level by level.
    const groups = groupChildren(closing.map(child), 1, chunkSize);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThan(closing.length);

    const ratio = closing.length / groups.length;
    expect(ratio).toBeGreaterThan(fanout / 4);
  });

  test('every child lands in exactly one group, in order', () => {
    const children = Array.from({ length: 300 }, (_, i) => child(`k${String(i).padStart(4, '0')}`));
    const groups = groupChildren(children, 1, 256);
    expect(groups.flat().map(c => c.lastKey)).toEqual(children.map(c => c.lastKey));
  });

  test('grouping depends only on the children, not on where they start', () => {
    // This is what lets patch regroup one node's children and get the same
    // answer a full rebuild would.
    const children = Array.from({ length: 300 }, (_, i) => child(`k${String(i).padStart(4, '0')}`));
    const whole = groupChildren(children, 1, 256);

    const firstGroupSize = whole[0].length;
    const tail = groupChildren(children.slice(firstGroupSize), 1, 256);
    expect(tail.map(g => g.length)).toEqual(whole.slice(1).map(g => g.length));
  });

  test('a level always shrinks, so building terminates', () => {
    for (const n of [2, 3, 17, 64, 300]) {
      const children = Array.from({ length: n }, (_, i) => child(`k${i}`));
      expect(groupChildren(children, 1, 256).length).toBeLessThan(n);
    }
  });
});

describe('buildTree', () => {
  test('empty document → single empty leaf root', () => {
    const tree = buildTree([], 4096);
    expect(tree.root.type).toBe(0x02);
    expect(tree.allNodes.size).toBe(1);
  });

  test('single entry → leaf root', () => {
    const tree = buildTree([['a', 1]], 4096);
    expect(tree.root.type).toBe(0x02);
    expect(tree.allNodes.size).toBe(1);
  });

  test('every node is reachable from the root', () => {
    const entries: [string, unknown][] = Array.from({ length: 400 }, (_, i) =>
      [`key-${String(i).padStart(5, '0')}`, { value: i }]
    );
    const tree = buildTree(entries as any, 256);

    const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
    const seen = new Set<string>();
    const visit = (chunkHash: Uint8Array) => {
      const h = hex(chunkHash);
      if (seen.has(h)) return;
      seen.add(h);
      const bytes = tree.allNodes.get(h);
      expect(bytes).toBeDefined();
      const node = decodeNode(bytes!, chunkHash);
      if (node.type === 0x01) node.children.forEach(visit);
    };
    visit(tree.root.chunkHash);

    // No node is written that the tree does not point at, and none is missing.
    expect(seen.size).toBe(tree.allNodes.size);
  });

  test('node sizes cluster around the target chunk size', () => {
    const entries: [string, unknown][] = Array.from({ length: 2000 }, (_, i) =>
      [`key-${String(i).padStart(6, '0')}`, { value: i, pad: 'x'.repeat(20) }]
    );
    const chunkSize = 1024;
    const tree = buildTree(entries as any, chunkSize);

    const sizes = [...tree.allNodes.values()].map(b => b.length).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const p95 = sizes[Math.floor(sizes.length * 0.95)];

    expect(median).toBeLessThan(chunkSize);
    expect(p95).toBeLessThan(chunkSize * 3);
    // Boundaries are content-defined, so chunk sizes are geometrically
    // distributed and the largest is a multiple of the target, not a hard cap.
    expect(sizes[sizes.length - 1]).toBeLessThan(chunkSize * 10);
  });

  test('all nodes stored in allNodes map', () => {
    const entries: [string, unknown][] = Array.from({ length: 50 }, (_, i) =>
      [`key-${String(i).padStart(5, '0')}`, i]
    );
    const tree = buildTree(entries as any, 128);
    // Root chunkHash must be in allNodes
    const rootHex = Array.from(tree.root.chunkHash).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(tree.allNodes.has(rootHex)).toBe(true);
  });

  test('chunk-size independence: same data different chunkSize → same root entryHash', () => {
    const entries: [string, unknown][] = Array.from({ length: 20 }, (_, i) =>
      [`entry-${String(i).padStart(5, '0')}`, { value: i }]
    );

    const tree1 = buildTree(entries as any, 128);
    const tree2 = buildTree(entries as any, 4096);

    // Root entryHash must be the same regardless of chunking
    expect(tree1.root.entryHash).toEqual(tree2.root.entryHash);
  });

  test('different data → different entryHash', () => {
    const entries1: [string, unknown][] = [['a', 1], ['b', 2]];
    const entries2: [string, unknown][] = [['a', 1], ['b', 99]];

    const tree1 = buildTree(entries1 as any, 4096);
    const tree2 = buildTree(entries2 as any, 4096);

    expect(tree1.root.entryHash).not.toEqual(tree2.root.entryHash);
  });

  test('sorted entries produce same tree as unsorted', () => {
    const entries: [string, unknown][] = [['c', 3], ['a', 1], ['b', 2]];
    const reversed: [string, unknown][] = [['b', 2], ['c', 3], ['a', 1]];

    const tree1 = buildTree(entries as any, 4096);
    const tree2 = buildTree(reversed as any, 4096);

    expect(tree1.root.entryHash).toEqual(tree2.root.entryHash);
  });
});
