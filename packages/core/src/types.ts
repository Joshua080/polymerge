/**
 * polymerge-core — SHARED TYPE CONTRACT
 * =====================================
 *
 * Every module in the monorepo (parsers, diff engine, CLI, web viewer, fixtures)
 * imports its domain types from this file and MUST NOT redefine them locally.
 * This file is owned by the project orchestrator; propose changes rather than
 * editing it from a feature module.
 *
 * Conventions
 * -----------
 * - Units: whatever the source file uses (no unit conversion in v1).
 * - Coordinates: right-handed, world space (glTF node transforms are baked in).
 * - Bulk data lives in typed arrays (interleaved xyz for positions, 3 indices per
 *   triangle for faces). Object-style views (IVertex, IFace) exist for reporting
 *   and UI only — the engine works on the arrays.
 * - "Base" = the old / left / ours-ancestor side. "Target" = the new / right side.
 *   Diff results are always expressed in TARGET space.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Vec3 = [x: number, y: number, z: number];

/** 4x4 matrix, column-major, length 16 (identical layout to three.js `Matrix4.elements`). */
export type Mat4 = number[];

export interface IBounds {
  min: Vec3;
  max: Vec3;
}

/** Formats accepted by the loaders. `gltf` = JSON glTF (embedded/data-URI buffers only in v1). */
export type SourceFormat = 'stl' | 'obj' | 'gltf' | 'glb';

export const SOURCE_FORMATS: readonly SourceFormat[] = ['stl', 'obj', 'gltf', 'glb'];

// ---------------------------------------------------------------------------
// Normalised mesh (the ONE internal representation every format is loaded into)
// ---------------------------------------------------------------------------

/**
 * NORMALISATION CONTRACT (implemented by `loadMesh`, relied on by the diff engine
 * and by the fixture expectations):
 *
 * 1. Parse with the stock three.js loader for the format (STLLoader / OBJLoader /
 *    GLTFLoader). No hand-written tokenizers.
 * 2. Walk the loaded scene in loader/traversal order. Only triangle geometry is
 *    kept (points/lines are skipped with a warning). World transforms are baked.
 * 3. Visit triangles in order (mesh order → face order → corner order 0,1,2).
 *    Each corner position is taken as float32.
 * 4. WELD: a corner reuses the index of the first previously-seen vertex whose
 *    float32 x, y, z are numerically equal (so -0 === 0). If `weldEpsilon > 0`
 *    corners within that distance are merged instead. Otherwise a new vertex is
 *    appended. => Vertex indices are "first appearance order in the triangle
 *    stream". The same geometry saved as STL, OBJ or GLB with the same face order
 *    therefore produces an identical IMesh — this is what makes Tier 1 work
 *    across formats.
 * 5. Triangles whose three welded corners are not three distinct vertices are
 *    dropped (counted in `metadata.degenerateFacesDropped`).
 * 6. Vertices never referenced by a triangle do not exist in the IMesh.
 */
export interface IMesh {
  /** Welded vertex pool, interleaved xyz, length = vertexCount * 3. Values are float32-exact. */
  positions: Float64Array;
  /** Triangles as vertex indices, length = faceCount * 3. Winding is preserved from the source. */
  faces: Uint32Array;
  vertexCount: number;
  faceCount: number;
  /**
   * Optional stable per-vertex identifiers carried by the source (e.g. glTF custom
   * attribute `_VERTEX_ID`). Length = vertexCount; `null` where unknown. Used by Tier 1.
   */
  vertexIds?: (string | null)[];
  /**
   * Named sub-meshes (OBJ object/group, glTF node/mesh, STL solid). ALWAYS at least one
   * group; groups are contiguous, ordered, non-overlapping and together cover
   * [0, faceCount). Default single group name = file base name or "default".
   */
  groups: IMeshGroup[];
  /** Materials referenced by `faceMaterials` / groups. May be empty. */
  materials: IMaterial[];
  /** Optional per-face material index into `materials` (-1 = none). Length = faceCount. */
  faceMaterials?: Int32Array;
  metadata: IMeshMetadata;
}

export interface IMeshGroup {
  name: string;
  /** First face index (inclusive). */
  faceStart: number;
  faceCount: number;
  /** Index into IMesh.materials, if the whole group uses one material. */
  materialIndex?: number;
}

export interface IMaterial {
  name: string;
  /** Linear RGBA in [0, 1]. */
  color?: [r: number, g: number, b: number, a: number];
  metalness?: number;
  roughness?: number;
}

export interface IMeshMetadata {
  format: SourceFormat;
  /** Original file name if known (e.g. "bracket_v2.stl"). */
  sourceName?: string;
  /** Vertex count as delivered by the three.js loader BEFORE welding (e.g. 3 × faces for STL). */
  sourceVertexCount: number;
  /** Triangle count as delivered by the loader, before degenerate removal. */
  sourceFaceCount: number;
  degenerateFacesDropped: number;
  /** Weld tolerance that was applied (0 = exact float32 equality). */
  weldEpsilon: number;
  /** Axis-aligned bounds of the welded positions. */
  bounds: IBounds;
  /** Non-fatal issues encountered while loading (skipped primitives, missing materials, ...). */
  warnings: string[];
  /** Format-specific extras (glTF asset.generator, STL header, OBJ material libs, ...). */
  extras?: Record<string, unknown>;
}

/** Object view of a single vertex (for reporting / UI; see `getVertex` in mesh.ts). */
export interface IVertex {
  index: number;
  position: Vec3;
  id?: string;
}

/** Object view of a single triangle (for reporting / UI; see `getFace` in mesh.ts). */
export interface IFace {
  index: number;
  vertices: [a: number, b: number, c: number];
  groupIndex: number;
  materialIndex?: number;
}

// ---------------------------------------------------------------------------
// Loading API  (implemented in src/parsers/)
// ---------------------------------------------------------------------------

export interface ILoadOptions {
  /** Force a format instead of detecting it from `fileName` / content sniffing. */
  format?: SourceFormat;
  /** File name; used for format detection, `metadata.sourceName` and the default group name. */
  fileName?: string;
  /** Weld tolerance in model units. 0 (default) = exact float32 equality. */
  weldEpsilon?: number;
}

/** Signature of the public loader (see src/parsers/index.ts). */
export type LoadMeshFn = (data: ArrayBuffer | Uint8Array, options?: ILoadOptions) => Promise<IMesh>;

/** Signature of the format detector: extension first, then content sniffing. Throws if unknown. */
export type DetectFormatFn = (data: ArrayBuffer | Uint8Array, fileName?: string) => SourceFormat;

/** Thrown by loaders for unsupported / corrupt input. */
export class MeshLoadError extends Error {
  constructor(
    message: string,
    public readonly format?: SourceFormat,
  ) {
    super(message);
    this.name = 'MeshLoadError';
  }
}

// ---------------------------------------------------------------------------
// Diff model  (implemented in src/diff/)
// ---------------------------------------------------------------------------

/**
 * Correspondence tiers, tried strictly in order:
 *  1 = direct lineage: vertex index / order and internal IDs.
 *  2 = topological: greedy geometric + adjacency matching (MeshGit-inspired).
 *  3 = point cloud: ICP rigid alignment + nearest-surface distance mapping.
 */
export type MatchTier = 1 | 2 | 3;

export const TIER_NAMES: Readonly<Record<MatchTier, string>> = {
  1: 'Tier 1 · index/ID (direct lineage)',
  2: 'Tier 2 · topological (geometric + adjacency)',
  3: 'Tier 3 · point cloud (ICP + nearest surface)',
};

/** Per-vertex status codes stored in Uint8Arrays. */
export const VertexStatus = {
  Unchanged: 0,
  Moved: 1,
  Added: 2,
  Removed: 3,
} as const;
export type VertexStatusCode = (typeof VertexStatus)[keyof typeof VertexStatus];

/** Per-face status codes stored in Uint8Arrays. */
export const FaceStatus = {
  Unchanged: 0,
  Modified: 1,
  Added: 2,
  Removed: 3,
} as const;
export type FaceStatusCode = (typeof FaceStatus)[keyof typeof FaceStatus];

/**
 * Canonical diff colour scheme (sRGB hex). The viewer MUST use exactly these.
 * Green = added, Red = removed, Yellow = moved/modified, neutral grey = unchanged.
 */
export const DIFF_COLORS = {
  added: '#22c55e',
  removed: '#ef4444',
  modified: '#facc15',
  unchanged: '#9ca3af',
} as const;

/**
 * Merge review colours (who shaped each face of a merged model). Deliberately disjoint from
 * DIFF_COLORS: a merge is about provenance, not added / removed / moved.
 */
export const MERGE_COLORS = {
  /** Untouched by either side. */
  unchanged: '#9ca3af',
  /** Taken from ours. */
  ours: '#3b82f6',
  /** Taken from theirs. */
  theirs: '#a855f7',
  /** The same change on both sides (convergent). */
  both: '#14b8a6',
  /** An unresolved conflict region (kept in its base state until resolved). */
  conflict: '#f97316',
} as const;

export interface IDiffLogger {
  info(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

export interface IDiffOptions {
  /**
   * Distance (model units, target space) above which a matched vertex counts as
   * Moved. Default: 1e-6 × the larger bounding-box diagonal of the two meshes.
   */
  moveEpsilon?: number;
  /**
   * Tier 3 only: nearest-surface distance above which a vertex counts as
   * Added (target side) or Removed (base side). Default: 1% of the larger
   * bounding-box diagonal.
   */
  surfaceTolerance?: number;
  /** Run exactly this tier (no fallback). For debugging / tests. */
  forceTier?: MatchTier;
  /** Override acceptance thresholds (quality score in [0, 1]) for Tier 1 and Tier 2. */
  thresholds?: { tier1?: number; tier2?: number };
  icp?: { maxIterations?: number; convergence?: number };
  /**
   * Tier 3: also estimate a uniform scale (unit mismatch, resize). Default true. When the
   * estimated scale is within 0.5% of a known length-unit factor it is snapped to it and
   * reported in `alignment.units`.
   */
  detectScale?: boolean;
  /**
   * Tiers 1/2: explain a whole-model motion (rigid or uniformly scaled, e.g. the same
   * lineage re-exported in other units) as ONE global `alignment` instead of N moved
   * vertices. Default true.
   */
  detectGlobalTransform?: boolean;
  /**
   * Recover parts (connected components) that moved rigidly on their own as Moved rather
   * than Removed + Added, and report every part motion in `IDiffResult.parts`. Default true.
   */
  detectParts?: boolean;
  /**
   * Log sink. Defaults to `console`. Regardless of the sink, the engine ALWAYS
   * emits one info line per tier attempt and one line naming the accepted tier.
   */
  logger?: IDiffLogger;
}

/** Record of one tier being tried. `IDiffResult.attempts` holds these in execution order. */
export interface ITierAttempt {
  tier: MatchTier;
  name: string;
  accepted: boolean;
  /** Quality score in [0, 1] that was compared against `threshold`. */
  score: number;
  threshold: number;
  /** Human-readable explanation of the accept / reject decision. */
  reason: string;
  durationMs: number;
  /** Tier-specific numbers (matched fraction, face agreement, ICP rms, iterations, ...). */
  metrics: Record<string, number>;
}

/** Length units recognised by unit-mismatch detection. */
export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** A detected unit conversion: target = factor × base (e.g. in → mm, factor 25.4). */
export interface IUnitConversion {
  from: LengthUnit;
  to: LengthUnit;
  factor: number;
}

/**
 * Global alignment mapping BASE space into TARGET space: the similarity transform
 * x ↦ scale·R·x + t (rigid when scale = 1).
 *  - Tier 3: the ICP solution (with uniform scale when the models differ in units/size).
 *  - Tiers 1 & 2: the identity, unless one rigid/similarity transform explains ≥ 90% of the
 *    matched vertices (a whole-model move or unit re-export) — then that transform, so a
 *    global move reads as one alignment instead of N moved vertices.
 */
export interface IRigidTransform {
  /** Column-major 4×4; its 3×3 block is scale·R. */
  matrix: Mat4;
  /** Uniform scale factor (1 = rigid). */
  scale: number;
  /** Present when `scale` was snapped to a known length-unit conversion factor. */
  units?: IUnitConversion;
  /** RMS residual of the alignment. 0 when it is the identity of Tiers 1/2; real (possibly > 0) for Tier 3 even when it settles on the identity. */
  rmsError: number;
  iterations: number;
  isIdentity: boolean;
}

/**
 * A part (connected component) that moved rigidly relative to the global alignment.
 *  - source 'registration': the part had lost its correspondence (it would have read as
 *    Removed + Added) and was re-matched by rigidly registering the two components.
 *  - source 'matched': the part was already matched; its matched vertices are explained by
 *    one rigid motion, which is reported for context (and for merging).
 */
export interface IPartMotion {
  source: 'registration' | 'matched';
  /** Vertices of the part's component in the base / target mesh (ascending). */
  baseVertices: Uint32Array;
  targetVertices: Uint32Array;
  /** Matched vertex pairs inside the part. */
  matchedVertices: number;
  /** Matched vertices deviating from the part's rigid motion by more than moveEpsilon (local edits on the moved part). */
  deformedVertices: number;
  /** The part's full transform, base space → target space (column-major; includes the global alignment). */
  matrix: Mat4;
  /** Rotation of the part relative to the global alignment. */
  rotationDeg: number;
  rotationAxis: Vec3;
  /** Displacement of the part's centroid relative to the global alignment (target space). */
  centroidShift: Vec3;
  /** RMS residual of the rigid fit over the part's non-deformed matched vertices. */
  rmsError: number;
  /** Group names (OBJ object, glTF node, ...) of the part's first face, when available. */
  baseName?: string;
  targetName?: string;
}

export interface IMeshSummary {
  format: SourceFormat;
  sourceName?: string;
  vertexCount: number;
  faceCount: number;
  bounds: IBounds;
}

/**
 * Aggregate counts. `unchanged` / `moved` (vertices) and `unchanged` / `modified` (faces)
 * are counted on the TARGET side; `added` is target-side and `removed` is base-side by
 * definition. (In Tiers 1/2 the matched counts are equal on both sides; in Tier 3 they
 * can differ.)
 */
export interface IDiffStats {
  vertices: { unchanged: number; moved: number; added: number; removed: number };
  faces: { unchanged: number; modified: number; added: number; removed: number };
  /** Over Moved target vertices (0 if none). */
  maxDisplacement: number;
  meanDisplacement: number;
}

/**
 * Result of `diffMeshes(base, target)`.
 *
 * Correspondence invariants:
 *  - Tiers 1 & 2 produce a one-to-one partial matching:
 *      targetToBase[t] === b  ⇔  baseToTarget[b] === t   (for b, t ≥ 0)
 *  - Tier 3 may map several target vertices to one base vertex. `baseToTarget[b]`
 *    is the nearest aligned target vertex whenever base vertex b lies within
 *    surfaceTolerance of the target surface, else -1 (so the two arrays need not be
 *    mutual inverses in Tier 3).
 *  - Unmatched ⇒ -1  (base side = Removed, target side = Added).
 *
 * Status rules:
 *  - Vertex (Tiers 1 & 2): matched & displacement ≤ moveEpsilon → Unchanged,
 *    matched & > moveEpsilon → Moved, unmatched → Added / Removed.
 *  - Vertex (Tier 3): classified by nearest-SURFACE distance d in aligned space:
 *    d ≤ moveEpsilon → Unchanged, d ≤ surfaceTolerance → Moved, else Added/Removed.
 *    Exception: vertices of a recovered moved part (see `parts`) are Moved, with
 *    displacement = |alignment·base[match] − target[t]| (how far the part moved).
 *  - Target face: any vertex Added, or (Tiers 1 & 2) the mapped vertex triple is not a
 *    base face → Added; else any vertex Moved → Modified; else Unchanged.
 *  - Base face: any vertex Removed, or (Tiers 1 & 2) the mapped triple is not a target
 *    face → Removed; else any vertex Moved → Modified; else Unchanged.
 *    (Faces are compared as unordered vertex triples.)
 */
export interface IDiffResult {
  schemaVersion: 1;
  base: IMeshSummary;
  target: IMeshSummary;
  /** Tier whose correspondence was accepted. */
  tier: MatchTier;
  tierName: string;
  /** Every tier attempted, in order. The last entry is the accepted one. */
  attempts: ITierAttempt[];
  alignment: IRigidTransform;
  /** The resolved epsilons actually used. */
  moveEpsilon: number;
  surfaceTolerance: number;
  /** length = base.vertexCount; -1 = removed. */
  baseToTarget: Int32Array;
  /** length = target.vertexCount; -1 = added. */
  targetToBase: Int32Array;
  /** VertexStatusCode per base vertex (Unchanged | Moved | Removed). */
  baseVertexStatus: Uint8Array;
  /** VertexStatusCode per target vertex (Unchanged | Moved | Added). */
  targetVertexStatus: Uint8Array;
  /**
   * Per TARGET vertex deviation used for classification, in target space:
   * Tiers 1 & 2 = |alignment·base[match] − target[t]|; Tier 3 = nearest-surface distance.
   * 0 for Added vertices.
   */
  displacement: Float32Array;
  /** FaceStatusCode per base face (Unchanged | Modified | Removed). */
  baseFaceStatus: Uint8Array;
  /** FaceStatusCode per target face (Unchanged | Modified | Added). */
  targetFaceStatus: Uint8Array;
  stats: IDiffStats;
  /** Parts that moved rigidly on their own (relative to `alignment`). Empty when none. */
  parts: IPartMotion[];
  durationMs: number;
}

/** Signature of the public diff entry point (see src/diff/index.ts). */
export type DiffMeshesFn = (base: IMesh, target: IMesh, options?: IDiffOptions) => IDiffResult;

/** One vertex-level move, for reports and UI inspection (see `describeVertexChange`). */
export interface IVertexChange {
  status: VertexStatusCode;
  baseIndex: number; // -1 if Added
  targetIndex: number; // -1 if Removed
  /** Base position mapped into target space (null if Added). */
  from: Vec3 | null;
  /** Target position (null if Removed). */
  to: Vec3 | null;
  /** to − from (null unless both exist). */
  delta: Vec3 | null;
  distance: number;
}

// ---------------------------------------------------------------------------
// Three-way merge  (implemented in src/merge/; semantics: docs/merge-design.md)
// ---------------------------------------------------------------------------

/** How a conflict region is settled: take one side's changes there, or neither. */
export type MergeResolution = 'ours' | 'theirs' | 'base';

/**
 * Atomic conflict kinds (docs/merge-design.md §4):
 *  - move-move: both sides moved the same vertex (locally, after frames) to different places;
 *  - move-delete: one side deleted a vertex the other moved;
 *  - delete-dependency: one side deleted a vertex the other side's new geometry is anchored to;
 *  - competing-additions: both added different faces on the same edge (or re-meshed the same region);
 *  - overlapping-additions: new geometry of both sides interpenetrates in space;
 *  - part-motion: both moved the same part, differently;
 *  - global-transform: both transformed the whole model, differently (not a pure unit conversion);
 *  - lineage: a side lost vertex identity (Tier 3 remesh) — vertex-level merging impossible;
 *  - collision: edits that are fine on each side damage the model only when COMBINED — surfaces
 *    now pass through each other, or faces fold over / collapse — where neither base, ours nor
 *    theirs had that damage (checked on the merged mesh; docs/merge-design.md §4).
 */
export type MergeConflictKind =
  | 'move-move'
  | 'move-delete'
  | 'delete-dependency'
  | 'competing-additions'
  | 'overlapping-additions'
  | 'part-motion'
  | 'global-transform'
  | 'lineage'
  | 'collision';

/** One conflict REGION (the mesh analogue of a conflict hunk): resolved as a unit. */
export interface IMergeConflict {
  /** Stable, deterministic id (0-based, in order of discovery). */
  id: number;
  /** Atomic conflict kinds found in the region, with counts. */
  kinds: Partial<Record<MergeConflictKind, number>>;
  /** Human-readable summary. */
  message: string;
  /** Base vertices / faces inside the region (whole-model conflicts list none). */
  baseVertices: Uint32Array;
  baseFaces: Uint32Array;
  /** Vertices of ours / theirs involved in the region (their own indices). */
  oursVertices: Uint32Array;
  theirsVertices: Uint32Array;
  /** A point to look at, in the merged frame. */
  focus: Vec3;
  /** Applied resolution; null = unresolved (the region is left in its BASE state). */
  resolution: MergeResolution | null;
  /** True for global-transform / lineage conflicts (they concern the whole model). */
  wholeModel: boolean;
}

export interface IMergeStats {
  /** Base vertices whose local move was taken from ours / theirs / both (identical). */
  movedFromOurs: number;
  movedFromTheirs: number;
  movedConvergent: number;
  /** Base vertices deleted because ours / theirs / both deleted them. */
  deletedFromOurs: number;
  deletedFromTheirs: number;
  deletedConvergent: number;
  /** Faces added by ours / theirs / both (identical additions counted once). */
  facesAddedFromOurs: number;
  facesAddedFromTheirs: number;
  facesAddedConvergent: number;
  /** Base faces removed in the merge. */
  facesRemoved: number;
  /** Parts whose motion was taken from ours / theirs. */
  partMotionsFromOurs: number;
  partMotionsFromTheirs: number;
  conflicts: number;
  unresolved: number;
}

/** Where every merged vertex / face came from (for review tools and the viewer). */
export interface IMergeProvenance {
  /** 0 = base, 1 = added by ours, 2 = added by theirs. */
  vertexSource: Uint8Array;
  /** Index in the source mesh (base / ours / theirs). */
  vertexIndex: Int32Array;
  /**
   * Bitmask of the sides whose change shaped the vertex: 1 = ours, 2 = theirs (a local move or
   * a part motion; whole-model frames are reported in `IMergeResult.frame` instead).
   */
  vertexChangedBy: Uint8Array;
  faceSource: Uint8Array;
  faceIndex: Int32Array;
  /** Conflict region id per merged vertex (-1 = none). */
  vertexConflict: Int32Array;
}

export interface IMergeOptions {
  /** Options for the two underlying diffs (base → ours, base → theirs). */
  diff?: IDiffOptions;
  /** Resolutions by conflict id (ids are deterministic for the same inputs). */
  resolutions?: Record<number, MergeResolution>;
  /** Resolution for every conflict not listed in `resolutions`; default null = leave unresolved (base). */
  defaultResolution?: MergeResolution | null;
  /** Log sink (defaults to console); the two diffs log their tiers through it too. */
  logger?: IDiffLogger;
  /**
   * Check the combination of both sides' edits for surfaces passing through each other and
   * folded faces that neither side had (`collision` conflicts, and warnings after
   * resolution). Default true.
   */
  detectCollisions?: boolean;
}

/**
 * Damage that only the chosen COMBINATION of resolutions creates (each resolution is fine on its
 * own): e.g. one region resolved 'ours' pushes a wall into geometry another region took from
 * 'theirs'. Reported, never auto-fixed: the resolutions were explicit choices.
 */
export interface IMergeWarning {
  kind: 'collision';
  message: string;
  /** Faces of `merged` involved (crossing pairs and folded faces). */
  mergedFaces: Uint32Array;
  /** Conflicts whose resolutions meet here. */
  conflicts: number[];
}

export interface IMergeResult {
  /** All non-conflicting changes applied; each conflict region per its resolution (base when unresolved). */
  merged: IMesh;
  /** True when there are no unresolved conflicts. */
  clean: boolean;
  conflicts: IMergeConflict[];
  stats: IMergeStats;
  /** Global frame of the merged model (base → merged). */
  frame: { source: 'base' | 'ours' | 'theirs' | 'both' | 'composed' | 'conflict'; transform: IRigidTransform };
  provenance: IMergeProvenance;
  /** Problems created by the combination of chosen resolutions (empty when none / unresolved). */
  warnings: IMergeWarning[];
  /** The correspondences the merge was computed from. */
  ours: IDiffResult;
  theirs: IDiffResult;
  durationMs: number;
}

export type MergeMeshesFn = (base: IMesh, ours: IMesh, theirs: IMesh, options?: IMergeOptions) => IMergeResult;

// ---------------------------------------------------------------------------
// Tooling contract: test-fixture manifest (fixtures/manifest.json)
// ---------------------------------------------------------------------------

/** Exact count, or inclusive [min, max] range. */
export type CountExpectation = number | [min: number, max: number];

export interface IFixtureExpectation {
  /** Tier(s) the engine may settle on for this pair. */
  acceptableTiers: MatchTier[];
  vertices?: Partial<Record<keyof IDiffStats['vertices'], CountExpectation>>;
  faces?: Partial<Record<keyof IDiffStats['faces'], CountExpectation>>;
  /** Expected normalised sizes of the loaded meshes (validates the parsers + welding). */
  baseMesh?: { vertexCount: number; faceCount: number };
  targetMesh?: { vertexCount: number; faceCount: number };
  /** For rigid-motion cases: the known base→target transform. */
  alignment?: {
    translation: Vec3;
    rotationAxis: Vec3;
    rotationDeg: number;
    tolerance: number;
    /** Expected uniform scale (default 1); compared with a relative tolerance of `tolerance`. */
    scale?: number;
    /** Expected unit conversion label, when the scale is a unit factor. */
    units?: IUnitConversion;
  };
  /** Expected number of reported part motions (`IDiffResult.parts.length`). */
  parts?: CountExpectation;
  /** Exact vertex-level correspondences that MUST hold: [baseIndex, targetIndex]. */
  mustMatch?: [base: number, target: number][];
}

export interface IFixtureCase {
  /** kebab-case id; files live in fixtures/cases/<id>/ */
  id: string;
  title: string;
  description: string;
  /** Paths relative to the fixtures/ directory, e.g. "cases/cube-moved-corner/base.stl". */
  base: string;
  target: string;
  expect: IFixtureExpectation;
}

export interface IFixtureManifest {
  version: 1;
  cases: IFixtureCase[];
}
