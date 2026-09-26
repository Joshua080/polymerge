/**
 * Messages between the viewer (main thread) and the diff worker.
 * Meshes and results cross by structured clone; the result's typed arrays are transferred
 * (zero-copy) back to the main thread.
 */
import type { IDiffOptions, IDiffResult, IMesh } from '@polymerge/core';

/** Diff options minus the logger (functions cannot cross threads; logs are streamed instead). */
export type WorkerDiffOptions = Omit<IDiffOptions, 'logger'>;

export interface IDiffRequest {
  type: 'diff';
  id: number;
  base: IMesh;
  target: IMesh;
  options: WorkerDiffOptions;
}

export type WorkerMessage =
  | { type: 'log'; id: number; level: 'info' | 'warn' | 'debug'; message: string }
  /** startedAt / finishedAt: when the diff ran, in epoch milliseconds (timeOrigin + now). */
  | { type: 'result'; id: number; result: IDiffResult; ms: number; startedAt: number; finishedAt: number }
  | { type: 'error'; id: number; message: string; stack?: string };

/** Typed-array buffers of a diff result, for the transfer list. */
export function resultTransferables(r: IDiffResult): ArrayBuffer[] {
  const arrays: ArrayBufferView[] = [
    r.baseToTarget,
    r.targetToBase,
    r.baseVertexStatus,
    r.targetVertexStatus,
    r.displacement,
    r.baseFaceStatus,
    r.targetFaceStatus,
    ...r.parts.flatMap((p) => [p.baseVertices, p.targetVertices]),
  ];
  const seen = new Set<ArrayBuffer>();
  for (const a of arrays) if (a.buffer instanceof ArrayBuffer) seen.add(a.buffer);
  return [...seen];
}
