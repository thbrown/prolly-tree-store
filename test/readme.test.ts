/**
 * The README's code samples, executed.
 *
 * Documentation that is never run drifts: the previous README advertised
 * `add /players/-` as an append while it actually produced an object with a "-"
 * key, and documented a chunk key layout the code had stopped using. These keep
 * the claims and the samples honest.
 */
import { test, expect } from 'vitest';
import { ProllyTreeStore, MemoryStorageAdapter } from '../src/index.js';

const K = ProllyTreeStore.asKey;
const P = ProllyTreeStore.asPointer;

test('quick start sample', async () => {
  const store = new ProllyTreeStore({ adapter: new MemoryStorageAdapter(), initialState: { chunkSize: 4096 } as never });
  await store.put(K('roster'), {
    team: 'Red Sox',
    players: [{ id: 1, name: 'Alice', position: 'P' }, { id: 2, name: 'Bob', position: 'SS' }],
  });
  expect(await store.get(K('roster'), P('/players/0/name'))).toBe('Alice');
  await store.patch(K('roster'), JSON.stringify([
    { op: 'replace', path: '/players/0/position', value: 'CF' },
    { op: 'add', path: '/players/-', value: { id: 3, name: 'Carol', position: '1B' } },
  ]) as never);
  const doc = await store.get(K('roster')) as any;
  expect(doc.players).toHaveLength(3);
  expect(doc.players[0].position).toBe('CF');
  expect(doc.players[2].name).toBe('Carol');
  expect(await store.getRootHash(K('roster'))).toMatch(/^[0-9a-f]{64}$/);
});

test('sync loop sample', async () => {
  const mk = () => new ProllyTreeStore({ adapter: new MemoryStorageAdapter(), initialState: { chunkSize: 4096 } as never });
  const local = mk(), remote = mk();
  const DOC = K('roster'), SYNCED = K('roster@synced');

  const initial = { team: 'Sox', players: [{ id: 1, hr: 0 }, { id: 2, hr: 0 }] };
  await local.put(DOC, initial);
  await local.put(SYNCED, initial);
  await remote.put(DOC, initial);

  expect(await local.getRootHash(DOC)).toBe(await remote.getRootHash(DOC));

  await local.patch(DOC, JSON.stringify([{ op: 'replace', path: '/players/1/hr', value: 12 }]) as never);
  expect(await local.getRootHash(DOC)).not.toBe(await remote.getRootHash(DOC));

  const outgoing = await local.diff(SYNCED, DOC);
  await remote.patch(DOC, outgoing);
  await local.put(SYNCED, await local.get(DOC));

  expect(await local.getRootHash(DOC)).toBe(await remote.getRootHash(DOC));
  expect(await remote.get(DOC)).toEqual(await local.get(DOC));
});

test('array patch sample from the patch section', async () => {
  const store = new ProllyTreeStore({ adapter: new MemoryStorageAdapter(), initialState: { chunkSize: 4096 } as never });
  await store.put(K('game'), { inning: 1, lineup: ['a', 'b', 'c', 'd', 'e'] });
  await store.patch(K('game'), JSON.stringify([
    { op: 'test', path: '/inning', value: 1 },
    { op: 'replace', path: '/inning', value: 2 },
    { op: 'add', path: '/lineup/0', value: 'Alice' },
    { op: 'remove', path: '/lineup/4' },
  ]) as never);
  expect(await store.get(K('game'))).toEqual({ inning: 2, lineup: ['Alice', 'a', 'b', 'c', 'e'] });
});

test('numeric object keys are addressable, as documented', async () => {
  const store = new ProllyTreeStore({ adapter: new MemoryStorageAdapter(), initialState: { chunkSize: 4096 } as never });
  await store.put(K('d'), { byId: { '3': { n: 'x' } } });
  expect(await store.get(K('d'), P('/byId/3'))).toEqual({ n: 'x' });
});

test('chunk key layout matches the documented shape', async () => {
  const adapter = new MemoryStorageAdapter();
  const store = new ProllyTreeStore({ adapter, initialState: { chunkSize: 4096 } as never });
  await store.put(K('mydoc'), { a: 1 });
  const chunk = adapter.keys().find(k => k.startsWith('chunks/'))!;
  expect(chunk).toMatch(/^chunks\/mydoc\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  expect(adapter.keys()).toContain('__root__/mydoc');
});
