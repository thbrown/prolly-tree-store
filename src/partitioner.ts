import type {
  PartitionerOptions,
  PartitionerState,
  StorageAdapter,
  JSONValue,
  JSONPatchDocument,
  JSONPointer,
  ContentHash,
  KeyString,
} from './types.js';
import { DEFAULT_CALIBRATION_TTL_MS } from './types.js';
import { BlobNotFoundError, RetryableStorageError } from './errors.js';
import { get as treeGet, getRootHash as treeGetRootHash } from './tree-read.js';
import { put as treePut, remove as treeRemove } from './tree-write.js';
import { patch as treePatch } from './tree-patch.js';
import { diff as treeDiff } from './tree-diff.js';
import { calibrate, loadState } from './calibration.js';

function withWriteRetries(adapter: StorageAdapter, retries: number): StorageAdapter {
  const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await fn(); } catch (e) {
        if (!(e instanceof RetryableStorageError)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  };
  return {
    persistBlob: (key, value) => retry(() => adapter.persistBlob(key, value)),
    readBlob: adapter.readBlob.bind(adapter),
    deleteBlob: (key) => retry(() => adapter.deleteBlob(key)),
    ...(adapter.readBlobs ? { readBlobs: adapter.readBlobs.bind(adapter) } : {}),
  };
}

export class ProllyTreeStore {
  private readonly adapter: StorageAdapter;
  private readonly calibrationTtlMs: number;
  private readonly encoder: ((doc: JSONValue) => JSONValue) | undefined;
  private readonly decoder: ((doc: JSONValue) => JSONValue) | undefined;
  private _state: Readonly<PartitionerState> | null;
  private _calibratePromise: Promise<PartitionerState> | null = null;

  constructor(options: PartitionerOptions) {
    const retries = options.writeRetries ?? 0;
    this.adapter = retries > 0 ? withWriteRetries(options.adapter, retries) : options.adapter;
    this.calibrationTtlMs = options.calibrationTtlMs ?? DEFAULT_CALIBRATION_TTL_MS;
    this.encoder = options.encoder;
    this.decoder = options.decoder;
    this._state = options.initialState
      ? (options.initialState as PartitionerState)
      : null;
  }

  get state(): Readonly<PartitionerState> | null {
    return this._state;
  }

  // ── Calibration ────────────────────────────────────────────────────────────

  async calibrate(): Promise<PartitionerState> {
    const state = await calibrate(this.adapter);
    this._state = state;
    return state;
  }

  private async ensureState(): Promise<PartitionerState> {
    if (this._state) return this._state;

    if (!this._calibratePromise) {
      this._calibratePromise = (async () => {
        const loaded = await loadState(this.adapter, this.calibrationTtlMs);
        const result = loaded ?? await this.calibrate();
        this._calibratePromise = null;
        return result;
      })();
    }

    return this._calibratePromise;
  }

  // ── Document reads ─────────────────────────────────────────────────────────

  async get(key: KeyString, pointer?: JSONPointer): Promise<JSONValue> {
    const result = await treeGet(key, this.adapter, pointer);
    return this.decoder ? this.decoder(result) : result;
  }

  async getRootHash(key: KeyString): Promise<ContentHash> {
    return treeGetRootHash(key, this.adapter);
  }

  // ── Document writes ────────────────────────────────────────────────────────

  async put(key: KeyString, value: JSONValue): Promise<ContentHash> {
    const state = await this.ensureState();
    return treePut(key, this.encoder ? this.encoder(value) : value, this.adapter, state);
  }

  async patch(key: KeyString, patches: JSONPatchDocument): Promise<ContentHash> {
    await this.ensureState();
    return treePatch(key, patches, this.adapter);
  }

  // ── Diffing ────────────────────────────────────────────────────────────────

  async diff(keyA: KeyString, keyB: KeyString): Promise<JSONPatchDocument> {
    return treeDiff(keyA, keyB, this.adapter);
  }

  // ── Deletion ───────────────────────────────────────────────────────────────

  async delete(key: KeyString): Promise<void> {
    return treeRemove(key, this.adapter);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  static asKey(raw: string): KeyString {
    if (!raw) throw new Error('Key must not be empty');
    return raw as KeyString;
  }

  static asPointer(raw: string): JSONPointer {
    if (raw !== '' && !raw.startsWith('/')) {
      throw new Error('JSON Pointer must be empty or start with "/"');
    }
    return raw as JSONPointer;
  }
}
