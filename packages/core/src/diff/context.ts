/**
 * Option resolution and the per-diff context: lazily built, shared acceleration
 * structures (face sets, adjacency, kd-trees, BVHs) so that each tier and the shared
 * classifier build every structure at most once.
 */
import { boundsDiagonal, computeBounds, IDENTITY_MAT4 } from '../mesh.js';
import type { IBounds, IDiffOptions, IMesh, IRigidTransform, MatchTier } from '../types.js';
import { buildAdjacency, buildVertexFaces, meanEdgeLengths, type IAdjacency } from './adjacency.js';
import { FaceSet } from './faceset.js';
import { KdTree, TriangleBvh } from './spatial.js';

/** Default acceptance thresholds (see tier1.ts / tier2.ts for the score definitions). */
export const DEFAULT_THRESHOLDS = Object.freeze({ tier1: 0.95, tier2: 0.6 });
export const DEFAULT_ICP = Object.freeze({ maxIterations: 50, convergence: 1e-7 });
/** moveEpsilon = MOVE_EPSILON_FACTOR × max bbox diagonal. */
export const MOVE_EPSILON_FACTOR = 1e-6;
/** surfaceTolerance = SURFACE_TOLERANCE_FACTOR × max bbox diagonal. */
export const SURFACE_TOLERANCE_FACTOR = 0.01;
/** Floor used when both meshes are degenerate (zero diagonal). */
export const EPSILON_FLOOR = 1e-12;

export interface IResolvedOptions {
  moveEpsilon: number;
  surfaceTolerance: number;
  /** max(bbox diagonal of base, bbox diagonal of target). */
  diagonal: number;
  thresholds: { tier1: number; tier2: number };
  icp: { maxIterations: number; convergence: number };
  forceTier?: MatchTier;
}

function checkNonNegative(name: string, v: number | undefined): void {
  if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
    throw new RangeError(`diffMeshes: ${name} must be a finite number ≥ 0 (got ${v})`);
  }
}

export function resolveOptions(baseBounds: IBounds, targetBounds: IBounds, options: IDiffOptions): IResolvedOptions {
  checkNonNegative('moveEpsilon', options.moveEpsilon);
  checkNonNegative('surfaceTolerance', options.surfaceTolerance);
  const t1 = options.thresholds?.tier1;
  const t2 = options.thresholds?.tier2;
  for (const [name, v] of [['thresholds.tier1', t1], ['thresholds.tier2', t2]] as const) {
    if (v !== undefined && !(v >= 0 && v <= 1)) throw new RangeError(`diffMeshes: ${name} must be in [0, 1] (got ${v})`);
  }
  const maxIt = options.icp?.maxIterations;
  if (maxIt !== undefined && !(Number.isInteger(maxIt) && maxIt >= 1)) {
    throw new RangeError(`diffMeshes: icp.maxIterations must be an integer ≥ 1 (got ${maxIt})`);
  }
  checkNonNegative('icp.convergence', options.icp?.convergence);
  if (options.forceTier !== undefined && ![1, 2, 3].includes(options.forceTier)) {
    throw new RangeError(`diffMeshes: forceTier must be 1, 2 or 3 (got ${String(options.forceTier)})`);
  }

  const diagonal = Math.max(boundsDiagonal(baseBounds), boundsDiagonal(targetBounds));
  const moveEpsilon = options.moveEpsilon ?? (diagonal > 0 ? MOVE_EPSILON_FACTOR * diagonal : EPSILON_FLOOR);
  const surfaceTolerance = Math.max(
    options.surfaceTolerance ?? (diagonal > 0 ? SURFACE_TOLERANCE_FACTOR * diagonal : EPSILON_FLOOR),
    moveEpsilon,
  );
  return {
    moveEpsilon,
    surfaceTolerance,
    diagonal,
    thresholds: { tier1: t1 ?? DEFAULT_THRESHOLDS.tier1, tier2: t2 ?? DEFAULT_THRESHOLDS.tier2 },
    icp: {
      maxIterations: maxIt ?? DEFAULT_ICP.maxIterations,
      convergence: options.icp?.convergence ?? DEFAULT_ICP.convergence,
    },
    forceTier: options.forceTier,
  };
}

export function identityAlignment(): IRigidTransform {
  return { matrix: Array.from(IDENTITY_MAT4), rmsError: 0, iterations: 0, isIdentity: true };
}

/** What every tier hands to the shared classifier. */
export interface ITierOutcome {
  tier: MatchTier;
  score: number;
  reason: string;
  metrics: Record<string, number>;
  /** length = target.vertexCount; -1 = unmatched. */
  targetToBase: Int32Array;
  /** length = base.vertexCount; -1 = unmatched. */
  baseToTarget: Int32Array;
  alignment: IRigidTransform;
  /**
   * Tier 3 only: nearest-SURFACE distance per vertex in aligned space (Infinity when
   * nothing lies within surfaceTolerance). Tiers 1/2 leave this undefined and the
   * classifier measures matched-pair displacement instead.
   */
  surfaceDistance?: { target: Float64Array; base: Float64Array };
}

export class DiffContext {
  readonly baseBounds: IBounds;
  readonly targetBounds: IBounds;
  private _bfs?: FaceSet;
  private _tfs?: FaceSet;
  private _badj?: IAdjacency;
  private _tadj?: IAdjacency;
  private _bvf?: IAdjacency;
  private _tvf?: IAdjacency;
  private _bel?: Float64Array;
  private _tel?: Float64Array;
  private _bkd?: KdTree;
  private _tkd?: KdTree;
  private _bbvh?: TriangleBvh;
  private _tbvh?: TriangleBvh;

  constructor(
    readonly base: IMesh,
    readonly target: IMesh,
    readonly options: IResolvedOptions,
    baseBounds?: IBounds,
    targetBounds?: IBounds,
  ) {
    this.baseBounds = baseBounds ?? computeBounds(base.positions);
    this.targetBounds = targetBounds ?? computeBounds(target.positions);
  }

  get baseFaceSet(): FaceSet {
    return (this._bfs ??= new FaceSet(this.base.faces));
  }
  get targetFaceSet(): FaceSet {
    return (this._tfs ??= new FaceSet(this.target.faces));
  }
  get baseAdjacency(): IAdjacency {
    return (this._badj ??= buildAdjacency(this.base.vertexCount, this.base.faces));
  }
  get targetAdjacency(): IAdjacency {
    return (this._tadj ??= buildAdjacency(this.target.vertexCount, this.target.faces));
  }
  /** Incident faces per base vertex (CSR). */
  get baseVertexFaces(): IAdjacency {
    return (this._bvf ??= buildVertexFaces(this.base.vertexCount, this.base.faces));
  }
  /** Incident faces per target vertex (CSR). */
  get targetVertexFaces(): IAdjacency {
    return (this._tvf ??= buildVertexFaces(this.target.vertexCount, this.target.faces));
  }
  get baseEdgeLengths(): Float64Array {
    return (this._bel ??= meanEdgeLengths(this.base.positions, this.baseAdjacency));
  }
  get targetEdgeLengths(): Float64Array {
    return (this._tel ??= meanEdgeLengths(this.target.positions, this.targetAdjacency));
  }
  get baseKd(): KdTree {
    return (this._bkd ??= new KdTree(this.base.positions));
  }
  get targetKd(): KdTree {
    return (this._tkd ??= new KdTree(this.target.positions));
  }
  get baseBvh(): TriangleBvh {
    return (this._bbvh ??= new TriangleBvh(this.base.positions, this.base.faces));
  }
  get targetBvh(): TriangleBvh {
    return (this._tbvh ??= new TriangleBvh(this.target.positions, this.target.faces));
  }
}

/** Percent formatting for reasons. */
export function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}
