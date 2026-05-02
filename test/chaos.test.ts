/**
 * Chaos / fuzz test.
 *
 * Runs a random sequence of put / patch / get / diff / getRootHash / delete
 * operations for CHAOS_DURATION_MS milliseconds, maintaining an independent
 * ground-truth map and asserting the adapter's output matches at each step.
 */

import { describe, test, expect } from 'vitest';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import type { JSONValue } from '../src/types.js';

const CHAOS_DURATION_MS = 5000;

// ─── RNG (seeded for reproducibility on failure) ──────────────────────────────

function makePrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

// ─── Value generators ─────────────────────────────────────────────────────────

function makeGenerators(r: () => number) {
  const ri = (n: number) => Math.floor(r() * n);
  const pick = <T>(arr: T[]) => arr[ri(arr.length)];

  function scalar(): JSONValue {
    const t = ri(5);
    if (t === 0) return ri(100);
    if (t === 1) return `s${ri(10)}`;
    if (t === 2) return r() < 0.5;
    if (t === 3) return null;
    return ri(1000) - 500;
  }

  function value(depth = 0): JSONValue {
    if (depth >= 2 || r() < 0.4) return scalar();
    if (r() < 0.6) {
      // object
      const keys = ['a', 'b', 'c', 'd'].slice(0, ri(3) + 1);
      const obj: Record<string, JSONValue> = {};
      for (const k of keys) obj[k] = value(depth + 1);
      return obj;
    }
    // array
    return Array.from({ length: ri(3) + 1 }, () => value(depth + 1));
  }

  function doc(): Record<string, JSONValue> {
    const keys = ['x', 'y', 'z', 'name', 'score', 'active'].slice(0, ri(4) + 1);
    const obj: Record<string, JSONValue> = {};
    for (const k of keys) obj[k] = value();
    return obj;
  }

  return { ri, pick, scalar, value, doc };
}

// ─── Ground-truth tracker ─────────────────────────────────────────────────────

type State = { exists: false } | { exists: true; doc: Record<string, JSONValue> };

function applyPatchToGroundTruth(
  doc: Record<string, JSONValue>,
  ops: Array<{ op: string; path: string; value?: JSONValue }>
): Record<string, JSONValue> {
  // Deep clone
  let result = JSON.parse(JSON.stringify(doc)) as Record<string, JSONValue>;
  for (const op of ops) {
    const parts = op.path.split('/').slice(1); // remove leading ''
    if (parts.length === 1) {
      const k = parts[0];
      if (op.op === 'replace' || op.op === 'add') result[k] = op.value!;
      else if (op.op === 'remove') delete result[k];
    }
    // deeper paths not needed for top-level-only chaos ops
  }
  return result;
}

// ─── Chaos loop ───────────────────────────────────────────────────────────────

describe('Chaos: random operation sequences', () => {
  test(`runs for ${CHAOS_DURATION_MS}ms without error or inconsistency`, async () => {
    const seed = Date.now() & 0xFFFFFFFF;
    const r = makePrng(seed);
    const { ri, pick, scalar, doc } = makeGenerators(r);

    const adapter = new MemoryStorageAdapter();
    const p = new ProllyTreeStore({
      adapter,
      initialState: { chunkSize: 512, prefetchWidth: 2 },
    });

    const docKeys = ['chaos-a', 'chaos-b', 'chaos-c'].map(ProllyTreeStore.asKey);
    const state = new Map<string, State>(docKeys.map(k => [k as string, { exists: false }]));

    const counters = { put: 0, patch: 0, get: 0, diff: 0, getRootHash: 0, delete: 0, errors: 0 };

    const deadline = Date.now() + CHAOS_DURATION_MS;

    while (Date.now() < deadline) {
      const key = pick(docKeys);
      const ks = key as string;
      const cur = state.get(ks)!;
      const op = ri(cur.exists ? 6 : 2); // bias toward put/get when nothing exists

      try {
        // ── put ───────────────────────────────────────────────────────────────
        if (op === 0) {
          const newDoc = doc();
          await p.put(key, newDoc);
          state.set(ks, { exists: true, doc: newDoc });
          counters.put++;
        }

        // ── get (verify) ──────────────────────────────────────────────────────
        else if (op === 1) {
          if (cur.exists) {
            const result = await p.get(key);
            expect(result).toEqual(cur.doc);
          }
          counters.get++;
        }

        // ── patch (top-level replace/add/remove) ──────────────────────────────
        else if (op === 2 && cur.exists) {
          const keys = Object.keys(cur.doc);
          const patchOp = ri(3);

          let ops: Array<{ op: string; path: string; value?: JSONValue }>;

          if (patchOp === 0 && keys.length > 0) {
            // replace a random existing key
            const k = pick(keys);
            const newVal = scalar();
            ops = [{ op: 'replace', path: `/${k}`, value: newVal }];
          } else if (patchOp === 1) {
            // add a new key
            const newKey = `new_${ri(5)}`;
            const newVal = scalar();
            ops = [{ op: 'add', path: `/${newKey}`, value: newVal }];
          } else if (patchOp === 2 && keys.length > 1) {
            // remove a key (keep at least 1)
            const k = pick(keys);
            ops = [{ op: 'remove', path: `/${k}` }];
          } else {
            ops = [];
          }

          if (ops.length > 0) {
            await p.patch(key, JSON.stringify(ops) as any);
            const newDoc = applyPatchToGroundTruth(cur.doc, ops);
            state.set(ks, { exists: true, doc: newDoc });
          }
          counters.patch++;
        }

        // ── getRootHash ───────────────────────────────────────────────────────
        else if (op === 3 && cur.exists) {
          const hash = await p.getRootHash(key);
          expect(hash).toMatch(/^[0-9a-f]{64}$/);
          counters.getRootHash++;
        }

        // ── diff + patch symmetry ─────────────────────────────────────────────
        else if (op === 4) {
          // Pick two keys that both exist
          const existing = docKeys.filter(k => (state.get(k as string) as State).exists);
          if (existing.length >= 2) {
            const [kA, kB] = [pick(existing), pick(existing)];
            const kAs = kA as string;
            const kBs = kB as string;

            if (kAs !== kBs) {
              const patch = await p.diff(kA, kB);
              const ops = JSON.parse(patch as string);

              // Apply diff(A, B) to a copy of A stored under a temp key
              const tempKey = ProllyTreeStore.asKey(`chaos-tmp-${ri(1000)}`);
              const docA = (state.get(kAs) as { exists: true; doc: Record<string, JSONValue> }).doc;
              const docB = (state.get(kBs) as { exists: true; doc: Record<string, JSONValue> }).doc;

              await p.put(tempKey, docA);
              if (ops.length > 0) await p.patch(tempKey, patch);

              const result = await p.get(tempKey);
              expect(result).toEqual(docB);

              await p.delete(tempKey);
            }
          }
          counters.diff++;
        }

        // ── delete ────────────────────────────────────────────────────────────
        else if (op === 5 && cur.exists) {
          await p.delete(key);
          state.set(ks, { exists: false });
          counters.delete++;
        }
      } catch (e) {
        counters.errors++;
        throw new Error(`Chaos failure (seed=${seed}): op=${op} key=${ks}\n${e}`);
      }
    }

    // Final consistency check: verify all existing docs still read correctly
    for (const [ks, s] of state) {
      if (s.exists) {
        const result = await p.get(ProllyTreeStore.asKey(ks));
        expect(result).toEqual(s.doc);
      }
    }

    const total = Object.values(counters).reduce((a, b) => a + b, 0);
    console.log(
      `Chaos done (seed=${seed}): ${total} ops — ` +
      Object.entries(counters).map(([k, v]) => `${k}=${v}`).join(', ')
    );

    expect(counters.errors).toBe(0);
  }, CHAOS_DURATION_MS + 5000); // vitest timeout = run time + 5s buffer
});
