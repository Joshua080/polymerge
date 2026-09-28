/**
 * Messages between the viewer (main thread) and the engine worker.
 * Meshes and results cross by structured clone; a diff result's typed arrays are transferred
 * (zero-copy) back to the main thread. Merge views are copied: the worker keeps the merge it
 * came from, to re-resolve it without recomputing the diffs.
 */
import type {
  IDiffOptions,
  IDiffResult,
  IDiffStats,
  IMergeConflict,
  IMergeOptions,
  IMergeProvenance,
  IMergeResult,
  IMergeStats,
  IMergeWarning,
  IMesh,
  IRigidTransform,
  MatchTier,
  MergeResolution,
} from '@polymerge/core';

/** Diff options minus the logger (functions cannot cross threads; logs are streamed instead). */
export type WorkerDiffOptions = Omit<IDiffOptions, 'logger'>;
export type WorkerMergeOptions = Omit<IMergeOptions, 'logger' | 'diff'> & { diff?: WorkerDiffOptions };

export interface IDiffRequest {
  type: 'diff';
  id: number;
  base: IMesh;
  target: IMesh;
  options: WorkerDiffOptions;
}

export interface IMergeRequest {
  type: 'merge';
  id: number;
  base: IMesh;
  ours: IMesh;
  theirs: IMesh;
  options: WorkerMergeOptions;
}

/** Re-resolve the last merge. `resolutions` is the complete set (absent id = unresolved). */
export interface IResolveRequest {
  type: 'resolve';
  id: number;
  resolutions: Record<number, MergeResolution>;
}

export type WorkerRequest = IDiffRequest | IMergeRequest | IResolveRequest;

/** One side of a merge, as much as the viewer needs of its diff. */
export interface IMergeSideView {
  tier: MatchTier;
  tierName: string;
  alignment: IRigidTransform;
  stats: IDiffStats;
  parts: number;
}

/** The parts of an IMergeResult the viewer uses (the full per-vertex diffs stay in the worker). */
export interface IMergeView {
  merged: IMesh;
  clean: boolean;
  conflicts: IMergeConflict[];
  stats: IMergeStats;
  frame: IMergeResult['frame'];
  provenance: IMergeProvenance;
  warnings: IMergeWarning[];
  ours: IMergeSideView;
  theirs: IMergeSideView;
  durationMs: number;
}

const sideView = (d: IDiffResult): IMergeSideView => ({
  tier: d.tier,
  tierName: d.tierName,
  alignment: d.alignment,
  stats: d.stats,
  parts: d.parts?.length ?? 0,
});

export function mergeView(r: IMergeResult): IMergeView {
  return {
    merged: r.merged,
    clean: r.clean,
    conflicts: r.conflicts,
    stats: r.stats,
    frame: r.frame,
    provenance: r.provenance,
    warnings: r.warnings,
    ours: sideView(r.ours),
    theirs: sideView(r.theirs),
    durationMs: r.durationMs,
  };
}

/** startedAt / finishedAt: when the work ran, in epoch milliseconds (timeOrigin + now). */
export type WorkerMessage =
  | { type: 'log'; id: number; level: 'info' | 'warn' | 'debug'; message: string }
  | { type: 'result'; id: number; result: IDiffResult; ms: number; startedAt: number; finishedAt: number }
  | { type: 'merged'; id: number; view: IMergeView; ms: number; startedAt: number; finishedAt: number }
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
