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
