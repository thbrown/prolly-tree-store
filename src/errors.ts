import type { KeyString, JSONPointer, JSONValue } from './types.js';

export class BlobNotFoundError extends Error {
  readonly key: KeyString;

  constructor(key: KeyString) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
    this.key = key;
  }
}

/**
 * Throw this from a StorageAdapter to signal that the failure is transient
 * and the operation is safe to retry (e.g. network timeout, rate limit).
 * Errors that are NOT RetryableStorageError are treated as fatal and will
 * not be retried even when writeRetries > 0.
 */
export class RetryableStorageError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RetryableStorageError';
    this.cause = cause;
  }
}

export class PatchTestFailedError extends Error {
  readonly pointer: JSONPointer;
  readonly expected: JSONValue;
  readonly actual: JSONValue;

  constructor(pointer: JSONPointer, expected: JSONValue, actual: JSONValue) {
    super(`Patch test failed at ${pointer}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    this.name = 'PatchTestFailedError';
    this.pointer = pointer;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown by `patch` for an RFC 6902 operation this library cannot apply —
 * an unrecognised `op`, or an array index outside the valid range.
 * The document is left unchanged.
 */
export class UnsupportedPatchOperationError extends Error {
  readonly op: string;

  constructor(op: string, detail: string) {
    super(`Unsupported patch operation "${op}": ${detail}`);
    this.name = 'UnsupportedPatchOperationError';
    this.op = op;
  }
}

/**
 * Thrown when a document cannot be represented in the flat keyspace — currently
 * only object keys containing a NUL byte, which is the tree key separator.
 */
export class InvalidDocumentError extends Error {
  readonly pointer: string;

  constructor(pointer: string, detail: string) {
    super(`Invalid document at ${pointer || '/'}: ${detail}`);
    this.name = 'InvalidDocumentError';
    this.pointer = pointer;
  }
}

/** Thrown when a stored root pointer was written by an incompatible version. */
export class UnsupportedFormatError extends Error {
  readonly found: unknown;
  readonly expected: number;

  constructor(found: unknown, expected: number) {
    super(`Unsupported on-disk format ${String(found)} (this build reads format ${expected})`);
    this.name = 'UnsupportedFormatError';
    this.found = found;
    this.expected = expected;
  }
}
