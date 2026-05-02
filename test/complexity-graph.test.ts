/**
 * Run with: npx vitest run test/complexity-graph.test.ts
 * Output:   complexity-report.html  (open in browser)
 */
import { test, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { put, remove } from '../src/tree-write.js';
import { get, getRootHash } from '../src/tree-read.js';
import { patch } from '../src/tree-patch.js';
import { diff } from '../src/tree-diff.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { toKey, toPatch, toPointer } from '../src/types.js';

const k = (s: string) => toKey(s);
const p = (ops: object[]) => toPatch(JSON.stringify(ops));
const ptr = (s: string) => toPointer(s);

const CHUNK_SIZE = 256;
const N_VALUES = [10, 25, 50, 100, 250, 500, 1000, 2500];

function makeDoc(n: number): Record<string, string> {
  const doc: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    doc[`key_${String(i).padStart(6, '0')}`] = `value_${i}`;
  }
  return doc;
}

function countReads(adapter: MemoryStorageAdapter): () => number {
  let singles = 0;
  let batches = 0;
  const origRead = adapter.readBlob.bind(adapter);
  const origBatch = adapter.readBlobs.bind(adapter);
  adapter.readBlob = async (...args) => { singles++; return origRead(...args); };
  adapter.readBlobs = async (...args) => {
    batches += args[0].length;
    return origBatch(...args);
  };
  return () => {
    adapter.readBlob = origRead;
    adapter.readBlobs = origBatch;
    return singles + batches;
  };
}

function countWrites(adapter: MemoryStorageAdapter): () => number {
  let count = 0;
  const orig = adapter.persistBlob.bind(adapter);
  adapter.persistBlob = async (...args) => {
    if ((args[0] as string).startsWith('chunks/')) count++;
    return orig(...args);
  };
  return () => { adapter.persistBlob = orig; return count; };
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

async function benchGetRootHash(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
    const stop = countReads(adapter);
    await getRootHash(k('doc'), adapter);
    results.push(stop());
  }
  return results;
}

async function benchGetFull(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
    const stop = countReads(adapter);
    await get(k('doc'), adapter);
    results.push(stop());
  }
  return results;
}

async function benchGetPointer(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
    const midKey = `key_${String(Math.floor(n / 2)).padStart(6, '0')}`;
    const stop = countReads(adapter);
    await get(k('doc'), adapter, ptr(`/${midKey}`));
    results.push(stop());
  }
  return results;
}

async function benchPut(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    const stop = countWrites(adapter);
    await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
    results.push(stop());
  }
  return results;
}

async function benchPatch1(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
    const stop = countWrites(adapter);
    await patch(k('doc'), p([{ op: 'replace', path: '/key_000000', value: 'updated' }]), adapter);
    results.push(stop());
  }
  return results;
}

async function benchDiffIdentical(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    const doc = makeDoc(n);
    await put(k('a'), doc, adapter, { chunkSize: CHUNK_SIZE });
    await put(k('b'), doc, adapter, { chunkSize: CHUNK_SIZE });
    const stop = countReads(adapter);
    await diff(k('a'), k('b'), adapter);
    results.push(stop());
  }
  return results;
}

// Vary d (changed entries) at fixed n=1000
const D_VALUES = [1, 5, 10, 25, 50, 100, 200];

async function benchDiffByChanged(): Promise<number[]> {
  const results: number[] = [];
  const n = 1000;
  const base = makeDoc(n);
  for (const d of D_VALUES) {
    const adapter = new MemoryStorageAdapter();
    const modified = { ...base };
    for (let i = 0; i < d; i++) {
      modified[`key_${String(i * Math.floor(n / d)).padStart(6, '0')}`] = `c_${i}`;
    }
    await put(k('a'), base, adapter, { chunkSize: CHUNK_SIZE });
    await put(k('b'), modified, adapter, { chunkSize: CHUNK_SIZE });
    const stop = countReads(adapter);
    await diff(k('a'), k('b'), adapter);
    results.push(stop());
  }
  return results;
}

async function benchDelete(): Promise<number[]> {
  const results: number[] = [];
  for (const n of N_VALUES) {
    const adapter = new MemoryStorageAdapter();
    await put(k('doc'), makeDoc(n), adapter, { chunkSize: CHUNK_SIZE });
    const before = adapter.size;
    await remove(k('doc'), adapter);
    results.push(before - adapter.size); // blobs deleted
  }
  return results;
}

// ── HTML report ───────────────────────────────────────────────────────────────

function chart(
  id: string,
  title: string,
  xLabel: string,
  xValues: number[],
  datasets: { label: string; color: string; data: number[] }[],
): string {
  // Pair each y value with its x coordinate so Chart.js log scale works correctly
  const pointDatasets = datasets.map(d => ({
    label: d.label,
    data: d.data.map((y, i) => ({ x: xValues[i], y })),
    borderColor: d.color,
    backgroundColor: d.color + '22',
    tension: 0.3,
    pointRadius: 4,
    fill: false,
  }));

  return `
  <div class="chart-wrap">
    <canvas id="${id}"></canvas>
  </div>
  <script>
  new Chart(document.getElementById('${id}'), {
    type: 'line',
    data: { datasets: ${JSON.stringify(pointDatasets)} },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: ${JSON.stringify(title)}, font: { size: 15 } },
        legend: { position: 'bottom' },
      },
      scales: {
        x: {
          type: 'logarithmic',
          title: { display: true, text: ${JSON.stringify(xLabel)} },
        },
        y: {
          type: 'logarithmic',
          title: { display: true, text: 'storage operations' },
        },
      },
    },
  });
  </script>`;
}

function buildHtml(data: {
  getRootHash: number[];
  getFull: number[];
  getPointer: number[];
  put: number[];
  patch1: number[];
  diffIdentical: number[];
  diffByChanged: number[];
  delete: number[];
}): string {
  const readColor = '#3b82f6';
  const writeColor = '#ef4444';
  const altColor = '#10b981';

  const charts = [
    chart('c-getrooth', 'getRootHash reads  —  O(1)', 'document entries (n)', N_VALUES, [
      { label: 'reads', color: readColor, data: data.getRootHash },
    ]),
    chart('c-get', 'get reads: full doc vs. single-pointer  —  O(n) vs O(log n)', 'document entries (n)', N_VALUES, [
      { label: 'full get (reads all leaves)', color: readColor, data: data.getFull },
      { label: 'get with /pointer (single path)', color: altColor, data: data.getPointer },
    ]),
    chart('c-put', 'put writes  —  O(n)', 'document entries (n)', N_VALUES, [
      { label: 'chunk writes', color: writeColor, data: data.put },
    ]),
    chart('c-patch', 'patch (1 op) writes vs. put writes  —  O(log n) vs O(n)', 'document entries (n)', N_VALUES, [
      { label: 'put chunk writes', color: writeColor, data: data.put },
      { label: 'patch (1 op) chunk writes', color: altColor, data: data.patch1 },
    ]),
    chart('c-diff-identical', 'diff (identical docs) reads  —  O(log n) via hash pruning', 'document entries (n)', N_VALUES, [
      { label: 'reads', color: readColor, data: data.diffIdentical },
    ]),
    chart('c-diff-changed', 'diff reads vs. d (changed entries), n=1000  —  O(d)', 'changed entries (d)', D_VALUES, [
      { label: 'reads', color: readColor, data: data.diffByChanged },
    ]),
    chart('c-delete', 'delete: blobs removed  —  O(n)', 'document entries (n)', N_VALUES, [
      { label: 'blobs deleted', color: writeColor, data: data.delete },
    ]),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>persistence-partitioner complexity report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; color: #f1f5f9; margin-bottom: 4px; }
  p.sub { color: #94a3b8; font-size: .85rem; margin-top: 0; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); gap: 24px; }
  .chart-wrap { background: #1e293b; border-radius: 12px; padding: 20px; }
  canvas { max-height: 320px; }
</style>
</head>
<body>
<h1>persistence-partitioner &mdash; complexity report</h1>
<p class="sub">Storage operations (reads / chunk writes) vs. document size.
  chunkSize=${CHUNK_SIZE} bytes &nbsp;|&nbsp; generated ${new Date().toLocaleString()}</p>
<div class="grid">
${charts.join('\n')}
</div>
</body>
</html>`;
}

// ── Single test that collects everything and writes the file ──────────────────

test('generate complexity-report.html', async () => {
  const [
    getRootHashData,
    getFullData,
    getPointerData,
    putData,
    patch1Data,
    diffIdenticalData,
    diffByChangedData,
    deleteData,
  ] = await Promise.all([
    benchGetRootHash(),
    benchGetFull(),
    benchGetPointer(),
    benchPut(),
    benchPatch1(),
    benchDiffIdentical(),
    benchDiffByChanged(),
    benchDelete(),
  ]);

  const html = buildHtml({
    getRootHash: getRootHashData,
    getFull: getFullData,
    getPointer: getPointerData,
    put: putData,
    patch1: patch1Data,
    diffIdentical: diffIdenticalData,
    diffByChanged: diffByChangedData,
    delete: deleteData,
  });

  const outPath = new URL('../complexity-report.html', import.meta.url).pathname;
  writeFileSync(outPath, html);
  console.log(`\n  Report written → ${outPath}\n`);

  // Sanity: getRootHash should always be 1 read
  expect(getRootHashData.every(v => v === 1)).toBe(true);
  // patch writes should be far fewer than put writes for all n
  expect(patch1Data.every((v, i) => v < putData[i])).toBe(true);
}, 60_000);
