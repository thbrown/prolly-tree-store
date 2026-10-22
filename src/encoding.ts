import type { JSONValue, JSONPointer, StoredValue } from './types.js';
import { toPointer, ARRAY_MARKER } from './types.js';
import { InvalidDocumentError } from './errors.js';

const SEP = '\x00';
const INT_PAD = 10;

/**
 * Upper bound of the key range covered by a non-empty `prefix`.
 *
 * Every key under a prefix is either the prefix itself or starts with
 * `prefix + SEP`, so they all lie in `[prefix, prefixUpperBound(prefix))`.
 * The empty prefix covers the whole keyspace and has no such bound.
 */
export function prefixUpperBound(prefix: string): string {
  return prefix + '\x01';
}

/** True if `key` is `prefix` itself or lies beneath it. */
export function isUnderPrefix(key: string, prefix: string): boolean {
  return prefix === '' || key === prefix || key.startsWith(prefix + SEP);
}

/** Strip `prefix` from `key`, returning the remainder with no leading separator. */
export function relativeKey(key: string, prefix: string): string {
  if (prefix === '') return key;
  if (key === prefix) return '';
  return key.slice(prefix.length + 1);
}

/** Join a prefix and a relative key, either of which may be empty. */
export function joinKey(prefix: string, rest: string): string {
  if (prefix === '') return rest;
  if (rest === '') return prefix;
  return prefix + SEP + rest;
}

/**
 * Every proper ancestor container prefix of `key`, outermost first.
 *
 * The document root `''` is an ancestor of every non-root key and is included
 * first; the root key itself has no ancestors.
 */
export function ancestorPrefixes(key: string): string[] {
  if (key === '') return [];
  const out: string[] = [''];
  let idx = key.indexOf(SEP);
  while (idx !== -1) {
    out.push(key.slice(0, idx));
    idx = key.indexOf(SEP, idx + 1);
  }
  return out;
}

// ─── Array index segments ─────────────────────────────────────────────────────

/** Zero-pad an array index so lexicographic order matches numeric order. */
export function padIndex(n: number): string {
  return String(n).padStart(INT_PAD, '0');
}

/** True if a tree key segment is a padded array index. */
export function isPaddedIndex(segment: string): boolean {
  return segment.length === INT_PAD && /^\d{10}$/.test(segment);
}

/** True if a pointer segment could address an array index. */
export function isIndexSegment(segment: string): boolean {
  return /^(0|[1-9]\d*)$/.test(segment);
}

/** The RFC 6902 "append" token, valid as the last segment of an `add` path. */
export const APPEND_TOKEN = '-';

// ─── RFC 6901 pointers ────────────────────────────────────────────────────────

/**
 * Split an RFC 6901 JSON Pointer into its segments.
 *
 * Segments are returned in their *escaped* form, which is exactly the form
 * `flattenDocument` stores object keys in — so a segment can be compared to a
 * stored tree key segment directly. Padding of array indices is deliberately
 * NOT done here: whether a numeric segment is an array index or an object key
 * depends on the stored container's shape, which only the tree knows. See
 * `resolvePointer` in ./pointer.ts.
 */
export function pointerSegments(pointer: JSONPointer | string): string[] {
  const p = pointer as string;
  if (p === '' || p === '/') return [];
  const raw = p.startsWith('/') ? p.slice(1) : p;
  return raw.split('/');
}

/**
 * Decode a NUL-delimited tree key back to an RFC 6901 JSON Pointer.
 *
 * "players\x000000000003\x00stats\x00era" → "/players/3/stats/era"
 *
 * Segments are already stored escaped, so they are emitted verbatim; only
 * padded array indices are converted back to plain numbers.
 */
export function treeKeyToPointer(treeKey: string): JSONPointer {
  if (treeKey === '') return toPointer('');

  const segments = treeKey
    .split(SEP)
    .map(segment => (isPaddedIndex(segment) ? String(parseInt(segment, 10)) : segment));

  return toPointer('/' + segments.join('/'));
}

/** Escape an object key into its stored / pointer-segment form (RFC 6901). */
export function escapeSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Inverse of `escapeSegment`. */
export function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

// ─── Document flattening ─────────────────────────────────────────────────────

/**
 * Flatten a JSON document into a map of tree key → stored value.
 *
 * This defines the library's canonical stored form: for any document key `k`,
 * the stored leaf entries are exactly `flattenDocument(get(k))`.
 *
 * - Each scalar leaf gets one entry.
 * - Each array gets an `ARRAY_MARKER` entry at its own key, plus one subtree per
 *   element at a densely-numbered, zero-padded index. An empty array is the
 *   marker alone.
 * - Objects are the unmarked default; an empty object is stored as its own value.
 */
export function flattenDocument(
  doc: JSONValue,
  prefix: string = ''
): Map<string, StoredValue> {
  const result = new Map<string, StoredValue>();
  _flatten(doc, prefix, result);
  return result;
}

function _flatten(
  value: JSONValue,
  prefix: string,
  out: Map<string, StoredValue>
): void {
  if (Array.isArray(value)) {
    // The marker is written for empty and non-empty arrays alike, so container
    // shape is always recoverable (and always part of entryHash).
    out.set(prefix, ARRAY_MARKER);
    for (let i = 0; i < value.length; i++) {
      _flatten(value[i], joinKey(prefix, padIndex(i)), out);
    }
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.set(prefix, value);
      return;
    }
    for (const k of keys) {
      if (k.includes(SEP)) {
        throw new InvalidDocumentError(
          treeKeyToPointer(prefix) as string,
          'object keys must not contain a NUL byte'
        );
      }
      _flatten((value as Record<string, JSONValue>)[k], joinKey(prefix, escapeSegment(k)), out);
    }
  } else {
    out.set(prefix, value);
  }
}

/**
 * Reconstruct a JSON document from `[treeKey, value]` entries, whose keys are
 * relative to the level being rebuilt (the caller strips any common prefix).
 */
export function unflattenEntries(entries: [string, StoredValue][]): JSONValue {
  if (entries.length === 0) return {};
  return _unflatten(entries);
}

function _unflatten(entries: [string, StoredValue][]): JSONValue {
  if (entries.length === 0) return null;

  // An entry whose remaining key is empty describes *this* level: either a
  // scalar, an empty object, or an array marker.
  let self: StoredValue | undefined;
  const deeper: [string, StoredValue][] = [];
  for (const [k, v] of entries) {
    if (k === '') self = v;
    else deeper.push([k, v]);
  }

  const isArray = self === ARRAY_MARKER;

  if (deeper.length === 0) {
    if (isArray) return [];
    return self === undefined ? null : (self as JSONValue);
  }

  // Group the deeper entries by their first path segment
  const groups = new Map<string, [string, StoredValue][]>();
  for (const [k, v] of deeper) {
    const sepIdx = k.indexOf(SEP);
    const head = sepIdx === -1 ? k : k.slice(0, sepIdx);
    const rest = sepIdx === -1 ? '' : k.slice(sepIdx + 1);
    let group = groups.get(head);
    if (!group) groups.set(head, (group = []));
    group.push([rest, v]);
  }

  if (isArray) {
    // Indices are dense and zero-padded, so lexicographic order is numeric order.
    return [...groups.keys()]
      .sort()
      .map(head => _unflatten(groups.get(head)!));
  }

  const obj: Record<string, JSONValue> = {};
  for (const [head, group] of groups) {
    obj[unescapeSegment(head)] = _unflatten(group);
  }
  return obj;
}
