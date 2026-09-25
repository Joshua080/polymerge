/**
 * PUBLIC DIFF API — STUB. Owned by the Diff Engine agent, who replaces the bodies.
 * The exported names and signatures are part of the contract and must not change.
 */
import type { DiffMeshesFn, IDiffResult } from '../types.js';

export const diffMeshes: DiffMeshesFn = () => {
  throw new Error('diffMeshes: not implemented yet');
};

/** JSON-safe serialisation (typed arrays → plain arrays). */
export function serializeDiff(_result: IDiffResult): string {
  throw new Error('serializeDiff: not implemented yet');
}

/** Inverse of serializeDiff (plain arrays → typed arrays). */
export function deserializeDiff(_json: string): IDiffResult {
  throw new Error('deserializeDiff: not implemented yet');
}
