import { describe, test, expect } from 'vitest';
import { isBoundary, rollingHash, buildLeafNodes, buildTree } from '../src/prolly.js';
import { entryHashOf, combineEntryHashes, entryHashToContentHash } from '../src/hashing.js';
import { encodeValue } from '../src/serialization.js';

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

describe('buildLeafNodes', () => {
  test('empty entries → single empty leaf', () => {
    const leaves = buildLeafNodes([], 4096);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].node.type).toBe(0x02);
    expect(leaves[0].node.entries).toHaveLength(0);
  });

  test('single entry → single leaf', () => {
    const leaves = buildLeafNodes([['a', 1]], 4096);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].node.entries[0].key).toBe('a');
  });

  test('each leaf has valid chunkHash (64-char hex)', () => {
    const entries: [string, unknown][] = Array.from({ length: 10 }, (_, i) => [`key-${i}`, i]);
    const leaves = buildLeafNodes(entries as any, 128);
    for (const { node } of leaves) {
      expect(node.chunkHash).toHaveLength(32);
    }
  });
});

describe('buildTree', () => {
  test('single entry → leaf root', () => {
    const tree = buildTree([['a', 1]], 4096);
    expect(tree.root.type).toBe(0x02);
    expect(tree.allNodes.size).toBe(1);
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
