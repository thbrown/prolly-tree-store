import type { JSONPointer, LeafEntry } from './types.js';
import {
  pointerSegments,
  padIndex,
  isPaddedIndex,
  isIndexSegment,
  joinKey,
  relativeKey,
  APPEND_TOKEN,
} from './encoding.js';
import { isArrayMarkerBytes } from './serialization.js';
import type { EntryReader } from './prefix-scan.js';

export interface ResolvedPointer {
  /** Stored tree key the pointer addresses. */
  treeKey: string;
  /** Stored tree key of the containing container (`''` at the document root). */
  parentKey: string;
  /** Whether that container is an array. */
  parentIsArray: boolean;
  /**
   * Array index addressed within the parent, or null when the parent is not an
   * array. For the `-` append token this is the array's current length.
   */
  index: number | null;
  /** Whether the final segment was the `-` append token. */
  isAppend: boolean;
}

/**
 * Resolve an RFC 6901 pointer against the stored document.
 *
 * A numeric pointer segment is padded to an array index only when the container
 * it indexes actually carries the array marker; otherwise it is an ordinary
 * object key. Deciding this from the stored shape rather than from the text of
 * the pointer is what makes `{"byId": {"3": ...}}` addressable.
 *
 * Costs one extra point lookup per numeric segment, memoised per container.
 */
export async function resolvePointer(
  pointer: JSONPointer | string,
  reader: EntryReader
): Promise<ResolvedPointer> {
  const segments = pointerSegments(pointer);

  const arrayCache = new Map<string, boolean>();
  const isArrayAt = async (key: string): Promise<boolean> => {
    const cached = arrayCache.get(key);
    if (cached !== undefined) return cached;
    const entry = await reader.getEntry(key);
    const result = entry !== null && isArrayMarkerBytes(entry.valueMsgpack);
    arrayCache.set(key, result);
    return result;
  };

  let treeKey = '';
  let parentKey = '';
  let parentIsArray = false;
  let index: number | null = null;
  let isAppend = false;

  for (const segment of segments) {
    parentKey = treeKey;
    parentIsArray = await isArrayAt(parentKey);
    index = null;
    isAppend = false;

    if (parentIsArray && segment === APPEND_TOKEN) {
      // Only meaningful as the last segment of an `add`; callers validate.
      index = await arrayLength(parentKey, reader);
      isAppend = true;
      treeKey = joinKey(parentKey, padIndex(index));
      continue;
    }

    if (parentIsArray && isIndexSegment(segment)) {
      index = parseInt(segment, 10);
      treeKey = joinKey(parentKey, padIndex(index));
      continue;
    }

    // Ordinary object key — stored verbatim in its escaped (pointer) form.
    // A numeric segment beneath a container that does not exist yet is ambiguous
    // (nothing is stored to tell us its shape); it resolves as an object key,
    // which is what `flattenDocument` produces for a freshly added object.
    treeKey = joinKey(parentKey, segment);
  }

  return { treeKey, parentKey, parentIsArray, index, isAppend };
}

/**
 * Number of elements in the array stored at `arrayKey`.
 *
 * Derived from the distinct immediate index segments beneath it rather than from
 * a stored count, so it cannot drift from the entries themselves.
 */
export async function arrayLength(
  arrayKey: string,
  reader: EntryReader
): Promise<number> {
  const entries = await reader.scanPrefix(arrayKey);
  return indexHeads(entries, arrayKey).size;
}

/**
 * The distinct immediate index segments beneath `arrayKey`, mapped to the
 * entries belonging to each element.
 */
export function groupArrayElements(
  entries: LeafEntry[],
  arrayKey: string
): Map<number, Array<{ relKey: string; valueMsgpack: Uint8Array }>> {
  const groups = new Map<number, Array<{ relKey: string; valueMsgpack: Uint8Array }>>();

  for (const entry of entries) {
    if (entry.key === arrayKey) continue; // the marker itself
    const rest = relativeKey(entry.key, arrayKey);
    const sepIdx = rest.indexOf('\x00');
    const head = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    if (!isPaddedIndex(head)) continue;
    const idx = parseInt(head, 10);
    const relKey = sepIdx === -1 ? '' : rest.slice(sepIdx + 1);
    let group = groups.get(idx);
    if (!group) groups.set(idx, (group = []));
    group.push({ relKey, valueMsgpack: entry.valueMsgpack });
  }

  return groups;
}

function indexHeads(entries: LeafEntry[], arrayKey: string): Set<number> {
  return new Set(groupArrayElements(entries, arrayKey).keys());
}
