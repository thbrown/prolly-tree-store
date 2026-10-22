/**
 * Real numbers for the README diagrams, measured against the built library so
 * the illustrations cannot drift from what the code actually does.
 */
import { ProllyTreeStore, MemoryStorageAdapter } from '../../dist/index.js';

const K = ProllyTreeStore.asKey;

class Counting extends MemoryStorageAdapter {
  reads = 0; writes = 0; deletes = 0; bytesWritten = 0;
  async readBlob(k) { this.reads++; return super.readBlob(k); }
  async persistBlob(k, v) { this.writes++; this.bytesWritten += v.length; return super.persistBlob(k, v); }
  async deleteBlob(k) { this.deletes++; return super.deleteBlob(k); }
  reset() { this.reads = 0; this.writes = 0; this.deletes = 0; this.bytesWritten = 0; }
}

const roster = (n) => ({
  team: 'Sandlot Sluggers',
  season: 2026,
  roster: Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `player-${String(i).padStart(3, '0')}`,
    number: i % 99,
    position: ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'][i % 9],
    stats: { ab: 40 + (i % 30), h: 10 + (i % 20), hr: i % 7, rbi: i % 23, avg: 0.2 + (i % 90) / 1000 },
  })),
});

const chunks = (adapter, key) => adapter.keys().filter(k => k.startsWith(`chunks/${key}/`));

const doc = roster(220);

// ── Chunk-size independence ──────────────────────────────────────────────────
const small = new Counting();
const large = new Counting();
const smallStore = new ProllyTreeStore({ adapter: small, initialState: { chunkSize: 4096 } });
const largeStore = new ProllyTreeStore({ adapter: large, initialState: { chunkSize: 65536 } });
await smallStore.put(K('roster'), doc);
await largeStore.put(K('roster'), doc);

const sizes = {
  smallChunkSize: 4096,
  largeChunkSize: 65536,
  smallChunks: chunks(small, 'roster').length,
  largeChunks: chunks(large, 'roster').length,
  entryHashSmall: await smallStore.getRootHash(K('roster')),
  entryHashLarge: await largeStore.getRootHash(K('roster')),
};

// ── Sync: one changed value ──────────────────────────────────────────────────
const sync = new Counting();
const syncStore = new ProllyTreeStore({ adapter: sync, initialState: { chunkSize: 4096 } });
await syncStore.put(K('before'), doc);
const changed = structuredClone(doc);
changed.roster[57].stats.hr = 31;
await syncStore.put(K('after'), changed);

const beforeChunkHashes = new Set(chunks(sync, 'before').map(k => k.split('/').pop()));
const afterChunkHashes = new Set(chunks(sync, 'after').map(k => k.split('/').pop()));
const movedChunks = [...afterChunkHashes].filter(h => !beforeChunkHashes.has(h));

sync.reset();
const patchDoc = await syncStore.diff(K('before'), K('after'));
const syncStats = {
  totalChunks: beforeChunkHashes.size,
  changedChunks: movedChunks.length,
  diffReads: sync.reads,
  rootHashBefore: await syncStore.getRootHash(K('before')),
  rootHashAfter: await syncStore.getRootHash(K('after')),
  patch: patchDoc,
  patchOps: JSON.parse(patchDoc).length,
};

// ── Patch: writes only the path ──────────────────────────────────────────────
const p = new Counting();
const patchStore = new ProllyTreeStore({ adapter: p, initialState: { chunkSize: 4096 } });
await patchStore.put(K('doc'), doc);
const totalBefore = chunks(p, 'doc').length;
p.reset();
await patchStore.patch(K('doc'), JSON.stringify([{ op: 'replace', path: '/roster/57/stats/hr', value: 31 }]));
const patchStats = {
  totalChunks: totalBefore,
  reads: p.reads,
  writes: p.writes,
  deletes: p.deletes,
  bytesWritten: p.bytesWritten,
  shared: totalBefore - p.writes,
};

// Full put of the same change, for comparison
const q = new Counting();
const putStore = new ProllyTreeStore({ adapter: q, initialState: { chunkSize: 4096 } });
await putStore.put(K('doc'), doc);
q.reset();
await putStore.put(K('doc'), changed);
const putStats = { reads: q.reads, writes: q.writes, bytesWritten: q.bytesWritten };

// ── Delete and gc ────────────────────────────────────────────────────────────
const d = new Counting();
const delStore = new ProllyTreeStore({ adapter: d, initialState: { chunkSize: 4096 } });
await delStore.put(K('doc'), doc);
const liveChunks = chunks(d, 'doc').length;

// An interrupted write: chunks land, the root commit does not.
const realPersist = d.persistBlob.bind(d);
d.persistBlob = async (key, value) => {
  if (String(key).startsWith('__root__')) throw new Error('interrupted');
  return realPersist(key, value);
};
try { await delStore.put(K('doc'), changed); } catch { /* expected */ }
d.persistBlob = realPersist;

const afterCrash = chunks(d, 'doc').length;
const reclaimed = await delStore.gc(K('doc'));
const deleteStats = {
  liveChunks,
  orphans: afterCrash - liveChunks,
  reclaimed,
  afterGc: chunks(d, 'doc').length,
  readableAfterCrash: Object.keys(await delStore.get(K('doc'))).length > 0,
};
await delStore.delete(K('doc'));
deleteStats.afterDelete = chunks(d, 'doc').length;

export const stats = { sizes, sync: syncStats, patch: patchStats, put: putStats, del: deleteStats };

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(stats, null, 2));
}
