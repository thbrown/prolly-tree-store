import { describe, test, expect } from 'vitest';
import { diff } from '../src/tree-diff.js';
import { patch } from '../src/tree-patch.js';
import { put } from '../src/tree-write.js';
import { get } from '../src/tree-read.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { toKey, toPatch } from '../src/types.js';

const key = (s: string) => toKey(s);

describe('diff', () => {
  test('identical documents → empty patch "[]"', async () => {
    const adapter = new MemoryStorageAdapter();
    const doc = { a: 1, b: 2 };
    await put(key('a'), doc, adapter);
    await put(key('b'), doc, adapter);
    expect(await diff(key('a'), key('b'), adapter)).toBe('[]');
  });

  test('changed scalar → replace op', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('a'), { x: 1 }, adapter);
    await put(key('b'), { x: 2 }, adapter);
    const patchDoc = JSON.parse(await diff(key('a'), key('b'), adapter) as string);
    expect(patchDoc).toContainEqual({ op: 'replace', path: '/x', value: 2 });
  });

  test('added key → add op', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('a'), { x: 1 }, adapter);
    await put(key('b'), { x: 1, y: 2 }, adapter);
    const ops = JSON.parse(await diff(key('a'), key('b'), adapter) as string);
    expect(ops.some(o => o.op === 'add' && o.path === '/y' && o.value === 2)).toBe(true);
  });

  test('removed key → remove op', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('a'), { x: 1, y: 2 }, adapter);
    await put(key('b'), { x: 1 }, adapter);
    const ops = JSON.parse(await diff(key('a'), key('b'), adapter) as string);
    expect(ops.some(o => o.op === 'remove' && o.path === '/y')).toBe(true);
  });

  test('diff/patch symmetry: patch(A, diff(A,B)) equals B', async () => {
    const adapter = new MemoryStorageAdapter();
    const docA = { name: 'Alice', score: 10, tags: ['a', 'b'] };
    const docB = { name: 'Bob', score: 20, extra: true };

    await put(key('a'), docA, adapter);
    await put(key('b'), docB, adapter);

    const patchDoc = await diff(key('a'), key('b'), adapter);
    await patch(key('a'), patchDoc, adapter);

    expect(await get(key('a'), adapter)).toEqual(docB);
  });

  test('diff is deterministic: calling twice returns same result', async () => {
    const adapter = new MemoryStorageAdapter();
    await put(key('a'), { x: 1, y: 2 }, adapter);
    await put(key('b'), { x: 1, z: 3 }, adapter);
    const d1 = await diff(key('a'), key('b'), adapter);
    const d2 = await diff(key('a'), key('b'), adapter);
    expect(d1).toBe(d2);
  });

  test('diff with larger documents', async () => {
    const adapter = new MemoryStorageAdapter();
    const docA: Record<string, number> = {};
    const docB: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      docA[`key${i}`] = i;
      docB[`key${i}`] = i;
    }
    docB['key25'] = 999; // one change

    await put(key('a'), docA, adapter);
    await put(key('b'), docB, adapter);

    const patchDoc = await diff(key('a'), key('b'), adapter);
    const ops = JSON.parse(patchDoc as string);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: 'replace', path: '/key25', value: 999 });
  });
});
