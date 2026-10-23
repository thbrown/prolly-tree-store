import { describe, test, expect } from 'vitest';
import {
  encodeValue,
  decodeValue,
  encodeNode,
  decodeNode,
  encodeRootPointer,
  decodeRootPointer,
  nodeBytesToBlob,
  blobToNodeBytes,
} from '../src/serialization.js';
import type { LeafNode, InternalNode, RootPointer } from '../src/types.js';
import { FORMAT_VERSION } from '../src/types.js';

describe('encodeValue / decodeValue', () => {
  const cases: [string, unknown][] = [
    ['string', 'hello'],
    ['number', 42],
    ['null', null],
    ['boolean', true],
    ['array', [1, 2, 3]],
    ['object', { a: 1, b: 'x' }],
    ['nested', { a: { b: [1, null, true] } }],
  ];

  for (const [label, value] of cases) {
    test(label, () => {
      const encoded = encodeValue(value as any);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(decodeValue(encoded)).toEqual(value);
    });
  }
});

describe('encodeNode / decodeNode — LeafNode', () => {
  test('roundtrip preserves entries', () => {
    const leaf: LeafNode = {
      type: 0x02,
      chunkHash: new Uint8Array(32).fill(1),
      entryHash: new Uint8Array(32).fill(2),
      entries: [
        { key: 'a', valueMsgpack: encodeValue(1) },
        { key: 'b', valueMsgpack: encodeValue('hello') },
      ],
    };

    const bytes = encodeNode(leaf);
    const decoded = decodeNode(bytes, leaf.chunkHash) as LeafNode;

    expect(decoded.type).toBe(0x02);
    expect(decoded.entries).toHaveLength(2);
    expect(decoded.entries[0].key).toBe('a');
    expect(decodeValue(decoded.entries[0].valueMsgpack)).toBe(1);
    expect(decoded.entries[1].key).toBe('b');
    expect(decodeValue(decoded.entries[1].valueMsgpack)).toBe('hello');
    expect(decoded.chunkHash).toEqual(leaf.chunkHash);
    expect(decoded.entryHash).toEqual(leaf.entryHash);
  });
});

describe('encodeNode / decodeNode — InternalNode', () => {
  const internal: InternalNode = {
    type: 0x01,
    chunkHash: new Uint8Array(32).fill(3),
    entryHash: new Uint8Array(32).fill(4),
    level: 1,
    keys: ['b', 'd', 'f'],
    children: [
      new Uint8Array(32).fill(10),
      new Uint8Array(32).fill(11),
      new Uint8Array(32).fill(12),
    ],
    childEntryHashes: [
      new Uint8Array(32).fill(20),
      new Uint8Array(32).fill(21),
      new Uint8Array(32).fill(22),
    ],
  };

  test('roundtrip preserves level, keys and children', () => {
    const decoded = decodeNode(encodeNode(internal), internal.chunkHash) as InternalNode;

    expect(decoded.type).toBe(0x01);
    expect(decoded.level).toBe(1);
    expect(decoded.keys).toEqual(['b', 'd', 'f']);
    expect(decoded.children).toHaveLength(3);
    expect(decoded.children[0]).toEqual(internal.children[0]);
  });

  test('roundtrip preserves each child entry hash', () => {
    // Carried so that patch can split or drop a node without reading siblings.
    const decoded = decodeNode(encodeNode(internal), internal.chunkHash) as InternalNode;

    expect(decoded.childEntryHashes).toHaveLength(3);
    expect(decoded.childEntryHashes[1]).toEqual(internal.childEntryHashes[1]);
  });

  test('one key, child and entry hash per child', () => {
    const decoded = decodeNode(encodeNode(internal), internal.chunkHash) as InternalNode;

    expect(decoded.keys).toHaveLength(decoded.children.length);
    expect(decoded.childEntryHashes).toHaveLength(decoded.children.length);
  });
});

describe('encodeRootPointer / decodeRootPointer', () => {
  test('roundtrip', () => {
    const root: RootPointer = {
      format: FORMAT_VERSION,
      chunkHash: new Uint8Array(32).fill(0xab),
      entryHash: new Uint8Array(32).fill(0xcd),
      chunkSize: 4096,
      calibratedAt: 1700000000000,
    };

    const blob = encodeRootPointer(root);
    const decoded = decodeRootPointer(blob);

    expect(decoded.chunkHash).toEqual(root.chunkHash);
    expect(decoded.entryHash).toEqual(root.entryHash);
    expect(decoded.chunkSize).toBe(4096);
    expect(decoded.calibratedAt).toBe(1700000000000);
  });
});

describe('nodeBytesToBlob / blobToNodeBytes', () => {
  test('roundtrip through base64', () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const blob = nodeBytesToBlob(bytes);
    expect(typeof blob).toBe('string');
    const back = blobToNodeBytes(blob);
    expect(back).toEqual(bytes);
  });
});
