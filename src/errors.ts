import type { KeyString, JSONPointer, JSONValue } from './types.js';

export class BlobNotFoundError extends Error {
  readonly key: KeyString;

  constructor(key: KeyString) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
    this.key = key;
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
