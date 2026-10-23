import type { JSONValue, StoredValue, LeafEntry, JSONPointer } from './types.js';
import { toPointer } from './types.js';
import { PatchTestFailedError, UnsupportedPatchOperationError } from './errors.js';
import {
  flattenDocument,
  unflattenEntries,
  isUnderPrefix,
  relativeKey,
  joinKey,
  ancestorPrefixes,
  padIndex,
} from './encoding.js';
import { encodeValue, decodeValue, isArrayMarkerBytes } from './serialization.js';
import { resolvePointer, groupArrayElements } from './pointer.js';
import type { EntryReader } from './prefix-scan.js';
import type * as jsonpatch from 'fast-json-patch';

/** A pending change to a single leaf entry. */
export type KeyMutation =
  | { key: string; op: 'set'; valueMsgpack: Uint8Array }
  | { key: string; op: 'del' };

const DELETED = Symbol('deleted');

/**
 * An in-memory layer of pending entry changes over a committed tree.
 *
 * RFC 6902 operations apply in order, each seeing the result of the previous, so
 * every read during patch planning has to go through the pending changes rather
 * than the stored tree. Because it implements `EntryReader`, pointer resolution
 * and value reads behave identically here and against committed storage.
 *
 * Nothing is written to the adapter until the whole op list has been planned,
 * which is what keeps a failing `test` op atomic.
 */
export class PendingState implements EntryReader {
  private readonly overlay = new Map<string, Uint8Array | typeof DELETED>();

  constructor(private readonly base: EntryReader) {}

  async getEntry(key: string): Promise<LeafEntry | null> {
    const pending = this.overlay.get(key);
    if (pending === DELETED) return null;
    if (pending !== undefined) return { key, valueMsgpack: pending };
    return this.base.getEntry(key);
  }

  async scanPrefix(prefix: string): Promise<LeafEntry[]> {
    const merged = new Map<string, Uint8Array>();
    for (const entry of await this.base.scanPrefix(prefix)) {
      merged.set(entry.key, entry.valueMsgpack);
    }
    for (const [key, value] of this.overlay) {
      if (!isUnderPrefix(key, prefix)) continue;
      if (value === DELETED) merged.delete(key);
      else merged.set(key, value);
    }
    return [...merged].map(([key, valueMsgpack]) => ({ key, valueMsgpack }));
  }

  async existsPrefix(prefix: string): Promise<boolean> {
    // Cannot delegate to the base reader's early exit: the overlay may have
    // deleted everything it would find, or added something it would not.
    return (await this.scanPrefix(prefix)).length > 0;
  }

  set(key: string, valueMsgpack: Uint8Array): void {
    this.overlay.set(key, valueMsgpack);
  }

  del(key: string): void {
    this.overlay.set(key, DELETED);
  }

  get pendingCount(): number {
    return this.overlay.size;
  }

  /** The planned changes, sorted by key. */
  toMutations(): KeyMutation[] {
    const mutations: KeyMutation[] = [];
    for (const [key, value] of this.overlay) {
      mutations.push(
        value === DELETED ? { key, op: 'del' } : { key, op: 'set', valueMsgpack: value }
      );
    }
    return mutations.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

/**
 * RFC 6902 value equality for `test` ops.
 *
 * Object member order is not significant in JSON, and the tree returns members
 * in sorted key order, so comparing serialised forms would fail a `test` whose
 * value happens to be written in a different order.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEquals(v, y[i]));
  }

  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every(k => Object.hasOwn(y, k) && deepEquals(x[k], y[k]));
}

// ─── Subtree primitives ───────────────────────────────────────────────────────

/** Read the JSON value stored at `treeKey`, or undefined if nothing is there. */
async function readValue(
  state: PendingState,
  treeKey: string
): Promise<JSONValue | undefined> {
  const entries = await state.scanPrefix(treeKey);
  if (entries.length === 0) return undefined;

  const relative = entries.map(
    e => [relativeKey(e.key, treeKey), decodeValue(e.valueMsgpack)] as [string, StoredValue]
  );
  return unflattenEntries(relative);
}

/** Write `value` at `treeKey`, replacing whatever was there. */
function writeSubtree(state: PendingState, treeKey: string, value: JSONValue): void {
  for (const [key, stored] of flattenDocument(value, treeKey)) {
    state.set(key, encodeValue(stored));
  }
}

/** Delete everything at or beneath `treeKey`. */
async function deleteSubtree(state: PendingState, treeKey: string): Promise<void> {
  for (const entry of await state.scanPrefix(treeKey)) {
    state.del(entry.key);
  }
}

/**
 * Clear any leaf value sitting where an ancestor container of `treeKey` must be.
 *
 * Adding `/a/b` when `/a` holds `{}` or a scalar has to drop that leaf entry,
 * or the stored form would hold both a value and children at the same key.
 * Array markers are left alone — they are the container, not a value in it.
 */
async function clearAncestorLeaves(state: PendingState, treeKey: string): Promise<void> {
  for (const ancestor of ancestorPrefixes(treeKey)) {
    const entry = await state.getEntry(ancestor);
    if (entry && !isArrayMarkerBytes(entry.valueMsgpack)) state.del(ancestor);
  }
}

/**
 * Restore the canonical form of a container that may have just been emptied.
 *
 * An object with no entries must be stored as its own `{}` value, since that is
 * what `flattenDocument({})` produces — otherwise a document patched down to
 * empty would not match a `put` of the same empty document. Arrays need nothing:
 * their marker already records an empty array.
 */
async function canonicalizeEmptied(
  state: PendingState,
  containerKey: string,
  containerIsArray: boolean
): Promise<void> {
  if (containerIsArray) return;
  if (await state.existsPrefix(containerKey)) return;
  state.set(containerKey, encodeValue({}));
}

// ─── Array element shifting ───────────────────────────────────────────────────

/**
 * Renumber an array's elements over the index range affected by an insert or a
 * removal, and write the result.
 *
 * The shift is computed as the *complete final state* of the affected range
 * rather than as per-element del/set pairs, because element `i`'s new key is
 * element `i+1`'s old key: emitted pairwise, a key-addressed mutation map would
 * clobber itself and silently drop elements.
 */
function applyRenumbering(
  state: PendingState,
  originalKeys: Set<string>,
  finalEntries: Map<string, Uint8Array>
): void {
  for (const [key, value] of finalEntries) state.set(key, value);
  for (const key of originalKeys) {
    if (!finalEntries.has(key)) state.del(key);
  }
}

function elementKey(arrayKey: string, index: number, relKey: string): string {
  return joinKey(joinKey(arrayKey, padIndex(index)), relKey);
}

/** Insert `value` at `index`, shifting elements at and after it up by one. */
async function insertArrayElement(
  state: PendingState,
  arrayKey: string,
  index: number,
  value: JSONValue
): Promise<void> {
  const groups = groupArrayElements(await state.scanPrefix(arrayKey), arrayKey);
  const length = groups.size;

  if (index < 0 || index > length) {
    throw new UnsupportedPatchOperationError(
      'add',
      `array index ${index} is out of range for an array of length ${length}`
    );
  }

  const originalKeys = new Set<string>();
  const finalEntries = new Map<string, Uint8Array>();

  for (let i = index; i < length; i++) {
    for (const { relKey, valueMsgpack } of groups.get(i) ?? []) {
      originalKeys.add(elementKey(arrayKey, i, relKey));
      finalEntries.set(elementKey(arrayKey, i + 1, relKey), valueMsgpack);
    }
  }

  for (const [key, stored] of flattenDocument(value, elementKey(arrayKey, index, ''))) {
    finalEntries.set(key, encodeValue(stored));
  }

  applyRenumbering(state, originalKeys, finalEntries);
}

/** Remove the element at `index`, shifting later elements down by one. */
async function removeArrayElement(
  state: PendingState,
  arrayKey: string,
  index: number
): Promise<void> {
  const groups = groupArrayElements(await state.scanPrefix(arrayKey), arrayKey);
  const length = groups.size;

  if (index < 0 || index >= length) {
    throw new UnsupportedPatchOperationError(
      'remove',
      `array index ${index} is out of range for an array of length ${length}`
    );
  }

  const originalKeys = new Set<string>();
  const finalEntries = new Map<string, Uint8Array>();

  for (let i = index; i < length; i++) {
    for (const { relKey, valueMsgpack } of groups.get(i) ?? []) {
      originalKeys.add(elementKey(arrayKey, i, relKey));
      if (i > index) finalEntries.set(elementKey(arrayKey, i - 1, relKey), valueMsgpack);
    }
  }

  applyRenumbering(state, originalKeys, finalEntries);
}

// ─── Operations ───────────────────────────────────────────────────────────────

type Resolved = Awaited<ReturnType<typeof resolvePointer>>;

async function resolve(state: PendingState, path: string, op: string): Promise<Resolved> {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) {
    throw new UnsupportedPatchOperationError(op, `invalid JSON Pointer ${JSON.stringify(path)}`);
  }
  const resolved = await resolvePointer(path, state);

  if (resolved.parentIsArray && resolved.index === null) {
    throw new UnsupportedPatchOperationError(
      op,
      `${path} indexes an array with a non-index key — array indices must be "-" or a non-negative integer`
    );
  }
  return resolved;
}

/**
 * Reject writing a member into something that is not a container.
 *
 * `add /a/b` where `/a` holds a scalar has no meaning: RFC 6902 calls it an
 * error, and silently creating an object there would invent structure the caller
 * never asked for. An empty object is a container and is written into normally.
 */
async function assertContainerParent(
  state: PendingState,
  target: Resolved,
  op: string,
  path: string
): Promise<void> {
  if (target.treeKey === '') return; // the whole document may always be written

  const entry = await state.getEntry(target.parentKey);
  if (entry === null) return; // an object container, or nothing yet
  if (isArrayMarkerBytes(entry.valueMsgpack)) return; // arrays route elsewhere

  const parent = decodeValue(entry.valueMsgpack);
  const isEmptyObject =
    parent !== null &&
    typeof parent === 'object' &&
    !Array.isArray(parent) &&
    Object.keys(parent).length === 0;

  if (!isEmptyObject) {
    throw new UnsupportedPatchOperationError(
      op,
      `the parent of ${path} holds a value, not a container`
    );
  }
}

async function addAt(state: PendingState, path: string, value: JSONValue): Promise<void> {
  const target = await resolve(state, path, 'add');

  if (target.parentIsArray) {
    await insertArrayElement(state, target.parentKey, target.index!, value);
    return;
  }

  await assertContainerParent(state, target, 'add', path);
  await clearAncestorLeaves(state, target.treeKey);
  await deleteSubtree(state, target.treeKey);
  writeSubtree(state, target.treeKey, value);
}

async function replaceAt(state: PendingState, path: string, value: JSONValue): Promise<void> {
  const target = await resolve(state, path, 'replace');

  // An array index must already exist: writing past the end would leave a hole
  // and break the dense-index invariant.
  if (target.parentIsArray) {
    const length = groupArrayElements(
      await state.scanPrefix(target.parentKey),
      target.parentKey
    ).size;
    if (target.isAppend || target.index! >= length) {
      throw new UnsupportedPatchOperationError(
        'replace',
        `array index ${target.isAppend ? '-' : target.index} is out of range for an array of length ${length}`
      );
    }
  }

  await assertContainerParent(state, target, 'replace', path);
  await clearAncestorLeaves(state, target.treeKey);
  await deleteSubtree(state, target.treeKey);
  writeSubtree(state, target.treeKey, value);
}

async function removeAt(state: PendingState, path: string): Promise<void> {
  const target = await resolve(state, path, 'remove');

  // A document always has a root. Removing the whole value would leave the root
  // pointer describing nothing; deleting the document is `store.delete(key)`.
  if (target.treeKey === '') {
    throw new UnsupportedPatchOperationError(
      'remove',
      'cannot remove the document root — use delete(key) to remove the document'
    );
  }

  if (target.parentIsArray) {
    if (target.isAppend) {
      throw new UnsupportedPatchOperationError('remove', 'the "-" token cannot be removed');
    }
    await removeArrayElement(state, target.parentKey, target.index!);
    return;
  }

  if (!(await state.existsPrefix(target.treeKey))) {
    throw new UnsupportedPatchOperationError('remove', `${path} does not exist`);
  }

  await deleteSubtree(state, target.treeKey);
  await canonicalizeEmptied(state, target.parentKey, false);
}

async function readAt(state: PendingState, path: string, op: string): Promise<JSONValue> {
  const source = await resolve(state, path, op);
  const value = await readValue(state, source.treeKey);
  if (value === undefined) {
    throw new UnsupportedPatchOperationError(op, `source path ${path} does not exist`);
  }
  return value;
}

/**
 * Plan `ops` onto `state`, in order.
 *
 * Throws before any adapter write if an op cannot be applied, so a rejected
 * patch leaves the stored document untouched.
 */
export async function applyOps(
  ops: readonly jsonpatch.Operation[],
  state: PendingState
): Promise<void> {
  for (const op of ops) {
    if (op === null || typeof op !== 'object') {
      throw new UnsupportedPatchOperationError(String(op), 'operation must be an object');
    }
    const path = (op as { path?: unknown }).path as string;

    switch (op.op) {
      case 'test': {
        const target = await resolve(state, path, 'test');
        const actual = await readValue(state, target.treeKey);
        const expected = (op as jsonpatch.TestOperation<JSONValue>).value;
        if (!deepEquals(actual ?? null, expected ?? null)) {
          throw new PatchTestFailedError(
            toPointer(path) as JSONPointer,
            expected as JSONValue,
            (actual ?? null) as JSONValue
          );
        }
        break;
      }

      case 'add':
        await addAt(state, path, (op as jsonpatch.AddOperation<JSONValue>).value);
        break;

      case 'replace':
        await replaceAt(state, path, (op as jsonpatch.ReplaceOperation<JSONValue>).value);
        break;

      case 'remove':
        await removeAt(state, path);
        break;

      case 'move': {
        const from = (op as jsonpatch.MoveOperation).from;
        if (path === from) break;
        // RFC 6902: `from` must not be a proper prefix of `path`. The root is a
        // proper prefix of every other location, so moving the whole document
        // into one of its own descendants is rejected too.
        if (from === '' || path.startsWith(from + '/')) {
          throw new UnsupportedPatchOperationError('move', 'cannot move a value into itself');
        }
        const value = await readAt(state, from, 'move');
        await removeAt(state, from);
        await addAt(state, path, value);
        break;
      }

      case 'copy': {
        const from = (op as jsonpatch.CopyOperation).from;
        const value = await readAt(state, from, 'copy');
        await addAt(state, path, value);
        break;
      }

      default:
        throw new UnsupportedPatchOperationError(
          String((op as { op?: unknown }).op),
          'not a recognised RFC 6902 operation'
        );
    }
  }
}
