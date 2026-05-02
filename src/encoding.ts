import type { JSONValue, JSONPointer } from './types.js';
import { toPointer } from './types.js';

const SEP = '\x00';
const INT_PAD = 10;

// ─── RFC 6901 pointer ↔ tree key ─────────────────────────────────────────────

/**
 * Encode an RFC 6901 JSON Pointer to a null-byte-delimited tree key.
 *
 * "/players/3/stats/era" → "players\x000000000003\x00stats\x00era"
 *
 * Integer segments are zero-padded to 10 digits so lexicographic order
 * matches numeric order. RFC 6901 escape sequences (~0, ~1) are unescaped
 * before encoding.
 */
export function pointerToTreeKey(pointer: JSONPointer | string): string {
  const p = pointer as string;
  if (p === '' || p === '/') return '';

  const raw = p.startsWith('/') ? p.slice(1) : p;
  return raw
    .split('/')
    .map(segment => {
      // RFC 6901 unescape: ~1 → '/', ~0 → '~' (in that order)
      const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      return /^\d+$/.test(unescaped)
        ? unescaped.padStart(INT_PAD, '0')
        : unescaped;
    })
    .join(SEP);
}

/**
 * Decode a null-byte-delimited tree key back to an RFC 6901 JSON Pointer.
 *
 * "players\x000000000003\x00stats\x00era" → "/players/3/stats/era"
 */
export function treeKeyToPointer(treeKey: string): JSONPointer {
  if (treeKey === '') return toPointer('');

  const segments = treeKey.split(SEP).map(segment => {
    // A padded integer segment is exactly INT_PAD digits — decode back to a plain number string
    const unpadded = /^\d{10}$/.test(segment) ? String(parseInt(segment, 10)) : segment;
    // RFC 6901 escape: '~' → '~0', '/' → '~1'
    return unpadded.replace(/~/g, '~0').replace(/\//g, '~1');
  });

  return toPointer('/' + segments.join('/'));
}

// ─── Document flattening ─────────────────────────────────────────────────────

/**
 * Flatten a JSON document into a map of tree-key → JSONValue.
 * Each leaf value (non-object, non-array, or empty container) gets one entry.
 * Empty arrays and objects are emitted as leaves with their value.
 */
export function flattenDocument(
  doc: JSONValue,
  prefix: string = ''
): Map<string, JSONValue> {
  const result = new Map<string, JSONValue>();
  _flatten(doc, prefix, result);
  return result;
}

function _flatten(
  value: JSONValue,
  prefix: string,
  out: Map<string, JSONValue>
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, value);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      const key = prefix === '' ? String(i).padStart(INT_PAD, '0') : prefix + SEP + String(i).padStart(INT_PAD, '0');
      _flatten(value[i], key, out);
    }
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.set(prefix, value);
      return;
    }
    for (const k of keys) {
      const escaped = k.replace(/~/g, '~0').replace(/\//g, '~1');
      const key = prefix === '' ? escaped : prefix + SEP + escaped;
      _flatten((value as Record<string, JSONValue>)[k], key, out);
    }
  } else {
    out.set(prefix, value);
  }
}

/**
 * Reconstruct a JSON document from a sorted array of [treeKey, JSONValue] entries.
 * Entries should use the same null-byte-delimited tree key format as flattenDocument.
 */
export function unflattenEntries(entries: [string, JSONValue][]): JSONValue {
  if (entries.length === 0) return {};
  return _unflatten(entries);
}

/**
 * Recursively reconstruct a value from entries whose keys are relative to the
 * current level (i.e. the common prefix has already been stripped by the caller).
 *
 * Each entry is [localKey, value] where localKey is the remaining key after
 * stripping the parent prefix and separator.
 */
function _unflatten(entries: [string, JSONValue][]): JSONValue {
  if (entries.length === 0) return null;

  // Single entry with no remaining path → this IS the leaf value
  if (entries.length === 1 && entries[0][0] === '') return entries[0][1];

  // Group by the first path segment, stripping it from each entry's key
  const groups = new Map<string, [string, JSONValue][]>();

  for (const [k, v] of entries) {
    if (k === '') {
      // Exact match at this level mixed with deeper keys — treat as object/array value
      // This shouldn't happen in normal flattenDocument output; skip the exact match.
      continue;
    }
    const sepIdx = k.indexOf(SEP);
    const head = sepIdx === -1 ? k : k.slice(0, sepIdx);
    const rest = sepIdx === -1 ? '' : k.slice(sepIdx + 1);
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head)!.push([rest, v]);
  }

  const heads = [...groups.keys()];
  if (heads.length === 0) return null;

  // All-numeric 10-digit heads → this is an array node
  const allNumeric = heads.every(h => /^\d{10}$/.test(h));

  if (allNumeric) {
    const sorted = heads.slice().sort();
    return sorted.map(head => _unflatten(groups.get(head)!));
  }

  // Object node
  const obj: Record<string, JSONValue> = {};
  for (const head of heads) {
    // Unescape RFC 6901 sequences (~1 → '/', ~0 → '~')
    const unescaped = head.replace(/~1/g, '/').replace(/~0/g, '~');
    obj[unescaped] = _unflatten(groups.get(head)!);
  }
  return obj;
}
