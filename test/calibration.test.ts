import { describe, test, expect } from 'vitest';
import { calibrate, loadState } from '../src/calibration.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';

describe('calibrate', () => {
  test('returns a valid PartitionerState', async () => {
    const adapter = new MemoryStorageAdapter();
    const state = await calibrate(adapter);

    expect(state.chunkSize).toBeGreaterThanOrEqual(4096);
    expect(state.chunkSize).toBeLessThanOrEqual(524288);
    expect(state.prefetchWidth).toBeGreaterThanOrEqual(2);
    expect(state.prefetchWidth).toBeLessThanOrEqual(32);
    expect(state.cacheSizeBytes).toBeGreaterThan(0);
    expect(['indexeddb', 'gcp', 'unknown']).toContain(state.detectedBackend);
    expect(state.calibratedAt).toMatch(/^\d{4}-\d{2}-\d{2}/); // ISO date
  });

  test('probe blobs are deleted after calibration', async () => {
    const adapter = new MemoryStorageAdapter();
    await calibrate(adapter);
    const remainingKeys = adapter.keys();
    const probeKeys = remainingKeys.filter(k => k.startsWith('__calibration__/probe_'));
    expect(probeKeys).toHaveLength(0);
  });

  test('persists state to __calibration__ key', async () => {
    const adapter = new MemoryStorageAdapter();
    await calibrate(adapter);
    const keys = adapter.keys();
    expect(keys).toContain('__calibration__');
  });

  test('always re-measures (returns fresh state)', async () => {
    const adapter = new MemoryStorageAdapter();
    const state1 = await calibrate(adapter);
    const state2 = await calibrate(adapter);
    // calibratedAt may differ by a few ms but both should be valid
    expect(state1.chunkSize).toBe(state2.chunkSize);
  });
});

describe('loadState', () => {
  test('returns null when no state persisted', async () => {
    const adapter = new MemoryStorageAdapter();
    expect(await loadState(adapter)).toBeNull();
  });

  test('returns state after calibrate', async () => {
    const adapter = new MemoryStorageAdapter();
    const saved = await calibrate(adapter);
    const loaded = await loadState(adapter);
    expect(loaded).not.toBeNull();
    expect(loaded!.chunkSize).toBe(saved.chunkSize);
  });

  test('returns null when state is expired', async () => {
    const adapter = new MemoryStorageAdapter();
    await calibrate(adapter);
    // 1 ms TTL — immediately expired
    const loaded = await loadState(adapter, 1);
    // Give it a moment to expire
    await new Promise(r => setTimeout(r, 5));
    const loaded2 = await loadState(adapter, 1);
    expect(loaded2).toBeNull();
  });

  test('returns state when within TTL', async () => {
    const adapter = new MemoryStorageAdapter();
    await calibrate(adapter);
    const loaded = await loadState(adapter, 60_000);
    expect(loaded).not.toBeNull();
  });
});
