import type { StorageAdapter, PartitionerState } from './types.js';
import { CALIBRATION_KEY, DEFAULT_CALIBRATION_TTL_MS, toKey, toBlob } from './types.js';
import { BlobNotFoundError } from './errors.js';

const PROBE_SIZES = [4096, 65536, 524288]; // 4 KB, 64 KB, 512 KB
const PROBE_READS = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nearestPow2(n: number): number {
  if (n <= 1) return 1;
  return Math.pow(2, Math.round(Math.log2(n)));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function makeProbeBlob(size: number): string {
  // Fill with 'x' repeated — just needs to be the right size
  return 'x'.repeat(size);
}

/**
 * Measure adapter latency/throughput and derive optimal tree parameters.
 * Writes and deletes probe blobs; does not touch document data.
 * Always re-measures even if a valid state exists.
 */
export async function calibrate(adapter: StorageAdapter): Promise<PartitionerState> {
  const probeKeys = PROBE_SIZES.map((size, i) => toKey(`__calibration__/probe_${size}_${i}`));

  // Write probes
  for (let i = 0; i < PROBE_SIZES.length; i++) {
    await adapter.persistBlob(probeKeys[i], toBlob(makeProbeBlob(PROBE_SIZES[i])));
  }

  // Measure read times
  const times: number[][] = PROBE_SIZES.map(() => []);
  for (let r = 0; r < PROBE_READS; r++) {
    for (let i = 0; i < PROBE_SIZES.length; i++) {
      const start = performance.now();
      await adapter.readBlob(probeKeys[i]);
      times[i].push(performance.now() - start);
    }
  }

  // Delete probes
  for (const k of probeKeys) {
    await adapter.deleteBlob(k);
  }

  // Derive parameters
  const overheadLatency = median(times[0]); // median 4 KB read time ≈ fixed cost
  const largeTime = median(times[2]);       // median 512 KB read time
  const payloadTime = Math.max(0.001, largeTime - overheadLatency);
  const throughputBytesPerMs = PROBE_SIZES[2] / payloadTime;
  const perKbLatency = 1 / (throughputBytesPerMs / 1024);

  const rawOptimal = overheadLatency * throughputBytesPerMs;
  const chunkSize = clamp(nearestPow2(rawOptimal), 4096, 524288);
  // IndexedDB theoretical optimal is huge; cap at 64 KB for local adapters
  const cappedChunkSize = overheadLatency < 10 ? Math.min(chunkSize, 65536) : chunkSize;

  const prefetchWidth = clamp(Math.ceil(overheadLatency / 15), 2, 32);
  const cacheSizeBytes = overheadLatency > 20 ? 20_971_520 : 4_194_304;

  const detectedBackend =
    overheadLatency < 10 ? 'indexeddb'
    : overheadLatency > 50 ? 'gcp'
    : 'unknown';

  const state: PartitionerState = {
    overheadLatency,
    perKbLatency,
    chunkSize: cappedChunkSize,
    prefetchWidth,
    cacheSizeBytes,
    calibratedAt: new Date().toISOString(),
    detectedBackend,
  };

  // Persist to adapter
  await adapter.persistBlob(CALIBRATION_KEY, toBlob(JSON.stringify(state)));

  return state;
}

/**
 * Load a persisted PartitionerState from the adapter.
 * Returns null if none exists or the state has expired (beyond ttlMs).
 */
export async function loadState(
  adapter: StorageAdapter,
  ttlMs: number = DEFAULT_CALIBRATION_TTL_MS
): Promise<PartitionerState | null> {
  try {
    const blob = await adapter.readBlob(CALIBRATION_KEY);
    const state: PartitionerState = JSON.parse(blob as string);
    const age = Date.now() - new Date(state.calibratedAt).getTime();
    if (age > ttlMs) return null;
    return state;
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
}
