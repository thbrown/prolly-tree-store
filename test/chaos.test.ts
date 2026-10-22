/**
 * Chaos / fuzz test.
 *
 * Runs a random sequence of put / patch / get / diff / getRootHash / delete
 * operations against an independent ground truth and asserts three invariants
 * after every mutation:
 *
 *  1. the whole document reads back equal to the ground truth;
 *  2. the root hash equals that of a fresh `put` of the ground truth — the
 *     canonical-form invariant, i.e. the stored form depends only on the logical
 *     content and never on the sequence of edits that produced it;
 *  3. every pointer into the document reads back the value the ground truth has
 *     at that pointer — so a partial read can never disagree with a full read.
 *
 * Ground truth is `fast-json-patch` itself, so RFC 6902 semantics (array index
 * shifting in particular) are checked against a reference implementation rather
 * than against a hand-rolled applier. Patches are generated at arbitrary depth,
 * including array inserts, removals and appends.
 */

import { describe, test, expect } from 'vitest';
import * as jsonpatch from 'fast-json-patch';
import { ProllyTreeStore } from '../src/partitioner.js';
import { MemoryStorageAdapter } from '../src/adapters/memory.js';
import { UnsupportedPatchOperationError } from '../src/errors.js';
import type { JSONValue } from '../src/types.js';

/** Soak longer with CHAOS_MS=60000 npx vitest run test/chaos.test.ts */
const CHAOS_DURATION_MS = Number(process.env.CHAOS_MS ?? 5000);

// ─── RNG (seeded for reproducibility on failure) ──────────────────────────────

function makePrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ─── Value generators ─────────────────────────────────────────────────────────

function makeGenerators(r: () => number) {
  const ri = (n: number) => Math.floor(r() * n);
  const pick = <T>(arr: T[]): T => arr[ri(arr.length)];

  function scalar(): JSONValue {
    const t = ri(6);
    if (t === 0) return ri(100);
    if (t === 1) return `s${ri(10)}`;
    if (t === 2) return r() < 0.5;
    if (t === 3) return null;
    if (t === 4) return ri(1000) - 500;
    return '';
  }

  // Object keys deliberately include numeric strings (which must NOT be read
  // back as an array) and keys needing RFC 6901 escapes.
  const objectKeys = ['a', 'b', 'c', 'd', '3', '0000000003', 'a/b', 'a~b', ''];

  function value(depth = 0): JSONValue {
    if (depth >= 3 || r() < 0.35) return scalar();
    const shape = r();
    if (shape < 0.15) return r() < 0.5 ? {} : [];
    if (shape < 0.6) {
      const obj: Record<string, JSONValue> = {};
      for (const k of objectKeys.slice(0, ri(4) + 1)) obj[k] = value(depth + 1);
      return obj;
    }
    return Array.from({ length: ri(4) }, () => value(depth + 1));
  }

  function doc(): JSONValue {
    if (r() < 0.1) return Array.from({ length: ri(4) }, () => value(1));
    const keys = ['x', 'y', 'z', 'name', 'score', 'items'].slice(0, ri(5) + 1);
    const obj: Record<string, JSONValue> = {};
    for (const k of keys) obj[k] = value();
    return obj;
  }

  return { ri, pick, scalar, value, doc };
}

// ─── Pointer helpers ──────────────────────────────────────────────────────────

const escapeSegment = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** Every pointer into `doc`, including the root and intermediate containers. */
function allPointers(doc: JSONValue, prefix = ''): string[] {
  const out = [prefix];
  if (Array.isArray(doc)) {
    doc.forEach((v, i) => out.push(...allPointers(v, `${prefix}/${i}`)));
  } else if (doc !== null && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      out.push(...allPointers(v, `${prefix}/${escapeSegment(k)}`));
    }
  }
  return out;
}

/** Pointers to containers, paired with whether each is an array. */
function containerPointers(doc: JSONValue, prefix = ''): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  if (Array.isArray(doc)) {
    out.push([prefix, true]);
    doc.forEach((v, i) => out.push(...containerPointers(v, `${prefix}/${i}`)));
  } else if (doc !== null && typeof doc === 'object') {
    out.push([prefix, false]);
    for (const [k, v] of Object.entries(doc)) {
      out.push(...containerPointers(v, `${prefix}/${escapeSegment(k)}`));
    }
  }
  return out;
}

function valueAtPointer(doc: JSONValue, pointer: string): JSONValue {
  if (pointer === '') return doc;
  let cur: JSONValue = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = Array.isArray(cur)
      ? (cur as JSONValue[])[Number(seg)]
      : (cur as Record<string, JSONValue>)[seg];
  }
  return cur;
}

// ─── Op generation ────────────────────────────────────────────────────────────

type Op = { op: string; path: string; value?: JSONValue; from?: string };

function makeOps(doc: JSONValue, g: ReturnType<typeof makeGenerators>): Op[] {
  const { ri, pick, value } = g;
  const pointers = allPointers(doc);
  const containers = containerPointers(doc);
  const ops: Op[] = [];
  const count = ri(3) + 1;

  for (let i = 0; i < count; i++) {
    // A scalar document has no containers to write into, so only whole-value
    // ops make sense there.
    const kind = containers.length === 0 ? 2 + ri(5) : ri(7);
    const [containerPath, isArray] = containers.length > 0 ? pick(containers) : ['', false];

    if (kind === 0) {
      // add — a new object key, or an array insert/append
      if (isArray) {
        const length = (valueAtPointer(doc, containerPath) as JSONValue[]).length;
        const index = ri(2) === 0 ? '-' : String(ri(length + 1));
        ops.push({ op: 'add', path: `${containerPath}/${index}`, value: value(1) });
      } else {
        ops.push({
          op: 'add',
          path: `${containerPath}/${escapeSegment(pick(['a', 'b', 'new', '7', 'k/1']))}`,
          value: value(1),
        });
      }
    } else if (kind === 1) {
      const removable = pointers.filter(p => p !== '');
      if (removable.length > 0) ops.push({ op: 'remove', path: pick(removable) });
    } else if (kind === 2) {
      ops.push({ op: 'replace', path: pick(pointers), value: value(1) });
    } else if (kind === 3) {
      const from = pick(pointers);
      ops.push({ op: 'move', from, path: pick(pointers) });
    } else if (kind === 4) {
      const from = pick(pointers);
      ops.push({ op: 'copy', from, path: pick(pointers) });
    } else if (kind === 5) {
      const path = pick(pointers);
      ops.push({ op: 'test', path, value: clone(valueAtPointer(doc, path)) });
    } else {
      ops.push({ op: 'replace', path: '', value: value(1) });
    }
  }

  return ops;
}

// ─── Chaos loop ───────────────────────────────────────────────────────────────

describe('Chaos: random operation sequences', () => {
  test(`runs for ${CHAOS_DURATION_MS}ms without error or inconsistency`, async () => {
    const seed = Date.now() & 0xffffffff;
    const r = makePrng(seed);
    const g = makeGenerators(r);
    const { ri, pick } = g;

    const adapter = new MemoryStorageAdapter();
    const store = new ProllyTreeStore({
      adapter,
      initialState: { chunkSize: 512 } as never,
    });

    const docKeys = ['chaos-a', 'chaos-b', 'chaos-c'].map(ProllyTreeStore.asKey);
    const truth = new Map<string, JSONValue | undefined>(docKeys.map(k => [k as string, undefined]));

    const counters = {
      put: 0, patch: 0, patchRejected: 0, get: 0, diff: 0, getRootHash: 0, delete: 0,
    };
    let step = 0;
    let lastOps: unknown = null;

    /** Assert the three invariants for one document. */
    const check = async (key: ReturnType<typeof ProllyTreeStore.asKey>) => {
      const expected = truth.get(key as string)!;

      expect(await store.get(key)).toEqual(expected);

      const probe = ProllyTreeStore.asKey(`canon-${ri(1_000_000)}`);
      await store.put(probe, clone(expected));
      expect(await store.getRootHash(key)).toBe(await store.getRootHash(probe));
      await store.delete(probe);

      for (const pointer of allPointers(expected)) {
        const actual = await store.get(key, ProllyTreeStore.asPointer(pointer));
        expect(actual).toEqual(valueAtPointer(expected, pointer));
      }
    };

    const deadline = Date.now() + CHAOS_DURATION_MS;

    try {
      while (Date.now() < deadline) {
        step++;
        const key = pick(docKeys);
        const ks = key as string;
        const current = truth.get(ks);
        const op = ri(current === undefined ? 2 : 6);

        // ── put ─────────────────────────────────────────────────────────────
        if (op === 0) {
          const next = g.doc();
          await store.put(key, clone(next));
          truth.set(ks, next);
          counters.put++;
          await check(key);
        }

        // ── get ─────────────────────────────────────────────────────────────
        else if (op === 1) {
          if (current !== undefined) await check(key);
          counters.get++;
        }

        // ── patch at arbitrary depth ────────────────────────────────────────
        else if (op === 2 && current !== undefined) {
          const ops = makeOps(current, g);
          lastOps = ops;

          // Only ops the reference implementation accepts are sent to the
          // store; invalid ones are covered by test/array-semantics.test.ts.
          let expected: JSONValue;
          try {
            expected = jsonpatch.applyPatch(clone(current), clone(ops) as never, true)
              .newDocument as JSONValue;
          } catch {
            counters.patchRejected++;
            continue;
          }

          // This library is stricter than the reference on malformed targets
          // (adding a member to a scalar, an out-of-range array index). When it
          // rejects, the rejection must be atomic: nothing changed.
          try {
            await store.patch(key, JSON.stringify(ops) as never);
          } catch (e) {
            if (!(e instanceof UnsupportedPatchOperationError)) throw e;
            expect(await store.get(key)).toEqual(current);
            counters.patchRejected++;
            continue;
          }

          truth.set(ks, expected);
          counters.patch++;
          await check(key);
        }

        // ── getRootHash ─────────────────────────────────────────────────────
        else if (op === 3 && current !== undefined) {
          expect(await store.getRootHash(key)).toMatch(/^[0-9a-f]{64}$/);
          counters.getRootHash++;
        }

        // ── diff + patch symmetry ───────────────────────────────────────────
        else if (op === 4) {
          const existing = docKeys.filter(k => truth.get(k as string) !== undefined);
          if (existing.length >= 2) {
            const keyA = pick(existing);
            const keyB = pick(existing.filter(k => k !== keyA));
            if (keyB !== undefined) {
              const patchDoc = await store.diff(keyA, keyB);
              lastOps = patchDoc;

              const temp = ProllyTreeStore.asKey(`chaos-tmp-${ri(1_000_000)}`);
              await store.put(temp, clone(truth.get(keyA as string)!));
              if (JSON.parse(patchDoc as string).length > 0) await store.patch(temp, patchDoc);

              const docB = truth.get(keyB as string)!;
              expect(await store.get(temp)).toEqual(docB);
              // diff must close the gap exactly, not merely produce equal JSON
              expect(await store.getRootHash(temp)).toBe(await store.getRootHash(keyB));
              expect(await store.diff(temp, keyB)).toBe('[]');

              await store.delete(temp);
            }
          }
          counters.diff++;
        }

        // ── delete ──────────────────────────────────────────────────────────
        else if (op === 5 && current !== undefined) {
          await store.delete(key);
          truth.set(ks, undefined);
          counters.delete++;
        }
      }
    } catch (e) {
      throw new Error(
        `Chaos failure (seed=${seed}) at step ${step}\n` +
          `ops: ${JSON.stringify(lastOps)}\n` +
          `${e instanceof Error ? e.stack : String(e)}`
      );
    }

    // The run is only meaningful if it actually exercised the interesting paths.
    expect(counters.put).toBeGreaterThan(0);
    expect(counters.patch).toBeGreaterThan(0);
    expect(counters.diff).toBeGreaterThan(0);

    // Deleting a document removes everything reachable from its root. Patches
    // can orphan a node that covers no entries (see applyMutationBatch), so gc
    // is what guarantees the store comes back to empty.
    for (const key of docKeys) await store.delete(key);
    for (const key of docKeys) await store.gc(key);
    expect(adapter.keys().filter(k => !k.startsWith('__calibration__'))).toEqual([]);
  }, CHAOS_DURATION_MS + 60_000);
});
