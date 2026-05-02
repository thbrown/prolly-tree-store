import { describe, test, expect, vi } from 'vitest';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';

function makePartitioner(options = {}) {
  return new ProllyTreeStore({
    adapter: new MemoryStorageAdapter(),
    ...options,
  });
}

describe('ProllyTreeStore', () => {
  test('state is null before any calibration', () => {
    const p = makePartitioner();
    expect(p.state).toBeNull();
  });

  test('state is set when initialState provided', () => {
    const p = makePartitioner({
      initialState: { chunkSize: 4096, prefetchWidth: 2 },
    });
    expect(p.state).not.toBeNull();
    expect((p.state as any).chunkSize).toBe(4096);
  });

  test('explicit calibrate() sets state', async () => {
    const p = makePartitioner();
    await p.calibrate();
    expect(p.state).not.toBeNull();
  });

  test('get does NOT trigger calibration', async () => {
    const adapter = new MemoryStorageAdapter();
    const p = new ProllyTreeStore({ adapter });
    const calibrateSpy = vi.spyOn(p, 'calibrate');

    // put directly using module functions (bypasses the class's lazy calibration)
    const { put } = await import('../src/tree-write.js');
    await put(ProllyTreeStore.asKey('doc'), { a: 1 }, adapter);

    await p.get(ProllyTreeStore.asKey('doc'));
    expect(calibrateSpy).not.toHaveBeenCalled();
  });

  test('getRootHash does NOT trigger calibration', async () => {
    const adapter = new MemoryStorageAdapter();
    const p = new ProllyTreeStore({ adapter });
    const calibrateSpy = vi.spyOn(p, 'calibrate');

    const { put } = await import('../src/tree-write.js');
    await put(ProllyTreeStore.asKey('doc'), { a: 1 }, adapter);

    await p.getRootHash(ProllyTreeStore.asKey('doc'));
    expect(calibrateSpy).not.toHaveBeenCalled();
  });

  test('put triggers calibration when no state', async () => {
    const p = makePartitioner();
    expect(p.state).toBeNull();
    await p.put(ProllyTreeStore.asKey('doc'), { x: 1 });
    expect(p.state).not.toBeNull();
  });

  test('full CRUD cycle', async () => {
    const p = makePartitioner({ initialState: { chunkSize: 4096, prefetchWidth: 2 } });
    const key = ProllyTreeStore.asKey('doc');

    await p.put(key, { name: 'Alice', score: 10 });
    expect(await p.get(key)).toEqual({ name: 'Alice', score: 10 });

    await p.patch(key, JSON.stringify([{ op: 'replace', path: '/score', value: 20 }]) as any);
    expect(await p.get(key)).toEqual({ name: 'Alice', score: 20 });

    const hash = await p.getRootHash(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    await p.delete(key);
    await expect(p.get(key)).rejects.toThrow();
  });
});

describe('ProllyTreeStore.asKey', () => {
  test('returns branded string for non-empty input', () => {
    expect(ProllyTreeStore.asKey('my-key')).toBe('my-key');
  });

  test('throws for empty string', () => {
    expect(() => ProllyTreeStore.asKey('')).toThrow();
  });
});

describe('ProllyTreeStore.asPointer', () => {
  test('accepts empty string', () => {
    expect(ProllyTreeStore.asPointer('')).toBe('');
  });

  test('accepts valid pointer', () => {
    expect(ProllyTreeStore.asPointer('/a/b/0')).toBe('/a/b/0');
  });

  test('throws for invalid pointer (no leading /)', () => {
    expect(() => ProllyTreeStore.asPointer('a/b')).toThrow();
  });
});
