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
 * - Units: whatever the source file uses (no unit conversion in v1), except STEP: always mm.
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

/**
 * Formats accepted by the loaders. `gltf` = JSON glTF (embedded/data-URI buffers only in v1).
 * `step` = STEP (ISO 10303-21, `.step` / `.stp`): tessellated by an importer the caller passes in
 * (`ILoadOptions.step`); read only, never written.
 */
export type SourceFormat = 'stl' | 'obj' | 'gltf' | 'glb' | 'step';

export const SOURCE_FORMATS: readonly SourceFormat[] = ['stl', 'obj', 'gltf', 'glb', 'step'];

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
  /**
   * Appearance beyond `materials` / `faceMaterials`: the full definition of every material (same
   * index as `materials`), the images they reference, and texture coordinates per face corner.
   * Set by the glTF loader (always, possibly empty) and by the merge; absent for STL / OBJ.
   * Semantics: docs/appearance-merge-design.md.
   */
  appearance?: IMeshAppearance;
  /**
   * Scene structure of a glTF source (nodes, local transforms, meshes, and the node each face
   * came from). Absent for STL / OBJ. Positions stay baked in world space; see IMeshScene.
   */
  scene?: IMeshScene;
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

/** glTF sampler parameters (numeric glTF / WebGL enums); an absent field means the glTF default. */
export interface ITextureSampler {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}

/** KHR_texture_transform of a texture slot. */
export interface ITextureTransform {
  offset?: [u: number, v: number];
  rotation?: number;
  scale?: [u: number, v: number];
  /** Overrides the slot's `texCoord`. */
  texCoord?: number;
}

/**
 * One texture slot of a material (glTF textureInfo resolved through its texture): which image,
 * sampled through which UV set, and how. Merged and compared as a whole; `image` is compared by
 * the image's content (`ITextureImage.hash`), never by index.
 */
export interface ITextureRef {
  /** Index into `IMeshAppearance.images`. */
  image: number;
  /** UV set the slot samples (glTF `texCoord`, i.e. TEXCOORD_n). */
  texCoord: number;
  sampler?: ITextureSampler;
  transform?: ITextureTransform;
  /** normalTexture.scale, when not 1. */
  scale?: number;
  /** occlusionTexture.strength, when not 1. */
  strength?: number;
  /** The image came from this texture extension's `source` (e.g. EXT_texture_webp), not `texture.source`. */
  sourceExtension?: string;
}

/** An image referenced by texture slots. Never decoded, never fetched. */
export interface ITextureImage {
  /**
   * Content identity: `<byteLength>:<64-bit hash>` of the embedded bytes, or `uri:<uri>` for an
   * external reference. Equal hashes = the same image, whatever its name or container.
   */
  hash: string;
  name?: string;
  mimeType?: string;
  /** Embedded bytes exactly as stored in the file (GLB bufferView or data: URI). */
  data?: Uint8Array;
  /** External URI exactly as written in the file. */
  uri?: string;
}

export type MaterialAlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

/**
 * Full glTF material definition. Every scalar property is present (glTF defaults filled in), so an
 * absent property and its default compare equal. Merged property by property; each texture slot and
 * each extension is one property (docs/appearance-merge-design.md §2).
 */
export interface IMaterialDefinition {
  /** glTF name; absent when unnamed (`IMaterial.name` then holds the loader's `material_<index>`). */
  name?: string;
  /** Linear RGBA (default [1, 1, 1, 1]). */
  baseColorFactor: [r: number, g: number, b: number, a: number];
  metallicFactor: number;
  roughnessFactor: number;
  /** Linear RGB (default [0, 0, 0]). */
  emissiveFactor: [r: number, g: number, b: number];
  alphaMode: MaterialAlphaMode;
  /** Meaningful in MASK mode only; 0.5 in every other mode. */
  alphaCutoff: number;
  doubleSided: boolean;
  baseColorTexture?: ITextureRef;
  metallicRoughnessTexture?: ITextureRef;
  normalTexture?: ITextureRef;
  occlusionTexture?: ITextureRef;
  emissiveTexture?: ITextureRef;
  /**
   * Other material extensions by name (KHR_materials_unlit, KHR_materials_emissive_strength, …),
   * each kept whole. Texture references inside them (`…Texture` objects) are ITextureRef.
   */
  extensions?: Record<string, unknown>;
  extras?: unknown;
}

/** Appearance layer of a mesh (see `IMesh.appearance`). */
export interface IMeshAppearance {
  /** Definition of every entry of `IMesh.materials`: same index, same length. */
  materials: IMaterialDefinition[];
  /** Images referenced by the definitions' texture slots. */
  images: ITextureImage[];
  /**
   * Texture coordinates per FACE CORNER, one array per UV set (index = TEXCOORD_n):
   * `uvs[set][(face * 3 + corner) * 2 + (0 = u | 1 = v)]`, corners in `IMesh.faces` order; NaN where
   * the face's source primitive has no such set. UVs belong to corners, not to welded vertices: a
   * vertex on a UV seam has different coordinates in the faces on either side of it.
   */
  uvs: Float32Array[];
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

/**
 * Scene structure of a glTF source (additive; `IMesh.scene`). Positions are still baked in world
 * space (NORMALISATION CONTRACT); this records how they were baked, so that a glTF writer can
 * rebuild the node hierarchy and un-bake each node's geometry into its local space instead of
 * writing one flat mesh (writers/gltf.ts). Set by the glTF loader (parsers/gltf-scene.ts) and
 * carried through merges (merge/structure.ts). Every index is into this object's own arrays.
 *
 * In a freshly loaded mesh `sources[g]` describes `groups[g]` (one group per glTF primitive
 * instance). A merge regroups faces by name, so consumers must go through `faceSources`.
 */
export interface IMeshScene {
  /** Scene name, if the file gives one. */
  name?: string;
  /** The loaded scene's nodes, in file order (for a single-scene file: the glTF node indices). */
  nodes: ISceneNode[];
  /** Root nodes, in scene order. */
  roots: number[];
  /** glTF meshes the nodes reference, in file order. */
  meshes: ISceneMesh[];
  /** Distinct (node, primitive) origins of faces. */
  sources: ISceneSource[];
  /** Per face: index into `sources`, or -1 when the face belongs to no node. Length = faceCount. */
  faceSources: Int32Array;
}

export interface ISceneNode {
  /** Node name as written in the file (unsanitised). */
  name?: string;
  /** Child nodes, in file order. */
  children: number[];
  /** Local transform exactly as the file states it: `matrix` (column-major), or any of T / R / S. */
  matrix?: Mat4;
  translation?: Vec3;
  /** Unit quaternion. */
  rotation?: [x: number, y: number, z: number, w: number];
  scale?: Vec3;
  /** Index into `IMeshScene.meshes`. */
  mesh?: number;
  /** World matrix (column-major) the node's geometry is baked with: parent world × local, computed as three.js does. */
  world: Mat4;
  /**
   * What else was baked into the node's geometry: 'skin' (posed by its skeleton), 'morph' (default
   * morph weights applied), 'instances' (EXT_mesh_gpu_instancing copies). Writers emit that
   * geometry as static triangles in the baked shape.
   */
  baked?: ('skin' | 'morph' | 'instances')[];
}

export interface ISceneMesh {
  /** Mesh name as written in the file (unsanitised). */
  name?: string;
}

export interface ISceneSource {
  /** Index into `IMeshScene.nodes`. */
  node: number;
  /** Primitive index within the node's mesh (-1 = none: faces a merge attached to the node). */
  primitive: number;
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
  /** STEP only, and required for it: the importer that tessellates the B-rep, and how finely. */
  step?: IStepLoadOptions;
}

// ---------------------------------------------------------------------------
// STEP  (implemented in src/parsers/step.ts)
// ---------------------------------------------------------------------------

/**
 * How a STEP file is turned into triangles. STEP stores exact surfaces (a B-rep), and only a
 * geometry kernel can tessellate them: polymerge uses OpenCascade's, from the optional
 * `occt-import-js` package (LGPL-2.1), which the caller loads and passes in, so polymerge-core
 * stays dependency-free.
 */
export interface IStepLoadOptions {
  /** The importer: the initialised `occt-import-js` module (anything with its `ReadStepFile`). */
  importer: IStepImporter;
  /**
   * Maximum distance between a triangle and the true surface, in millimetres (STEP models are
   * always loaded in mm). Two versions of a part MUST be tessellated with the same value, or
   * unchanged surfaces get different triangles: load the base first and pass its value
   * (`stepInfo(base).deflection`) for the other version. Default: derived from the model's size
   * (`stepDeflectionFor`).
   */
  deflection?: number;
  /** Maximum angle between neighbouring triangles on a curved surface, in radians (default 0.5). */
  angularDeflection?: number;
}

/** What a loaded STEP model records about its tessellation (`IMeshMetadata.extras.step`). */
export interface IStepInfo {
  /** Linear deflection used, in mm (see `IStepLoadOptions.deflection`). */
  deflection: number;
  /** Angular deflection used, in radians. */
  angularDeflection: number;
  /** Always 'mm': the importer converts inch, metre, ... files. */
  unit: 'mm';
  /** Solids and shells read (the importer's meshes; one group each). */
  solids: number;
  /** B-rep faces tessellated. */
  brepFaces: number;
}

/** The part of the `occt-import-js` API that polymerge uses. */
export interface IStepImporter {
  ReadStepFile(content: Uint8Array, params: IStepImportParams | null): IStepImportResult;
}

export interface IStepImportParams {
  linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
  linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
  linearDeflection?: number;
  angularDeflection?: number;
}

/** `occt-import-js` output: meshes in world space, a node tree that refers to them by index. */
export interface IStepImportResult {
  success: boolean;
  root?: IStepImportNode;
  meshes?: IStepImportMesh[];
}

export interface IStepImportNode {
  name?: string;
  /** Indices into `IStepImportResult.meshes`. */
  meshes?: number[];
  children?: IStepImportNode[];
}

/** One solid or shell. Colours are linear RGB in [0, 1]. */
export interface IStepImportMesh {
  name?: string;
  color?: readonly number[] | null;
  /** The B-rep faces, each a contiguous inclusive range of triangles. */
  brep_faces?: { first: number; last: number; color?: readonly number[] | null }[];
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index: { array: ArrayLike<number> };
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
 * Appearance kinds (glTF; docs/appearance-merge-design.md §5):
 *  - material-property: both sides changed the same property of the same material differently;
 *  - material-assignment: both sides gave the same face different materials;
 *  - uv-layout: both sides changed the UV layout of the same island(s) differently;
 *  - uv-overlap: islands whose UVs come from different sides now overlap in texture space on a
 *    common image, where no version had them overlap;
 *  - appearance-geometry: an appearance edit that cannot be decided without the geometry (one side
 *    replaced faces the other re-materialed / re-UV'd, or new faces take part in a UV conflict);
 *    always part of a geometry region.
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
  | 'collision'
  | 'material-property'
  | 'material-assignment'
  | 'uv-layout'
  | 'uv-overlap'
  | 'appearance-geometry';

/** What an appearance conflict is about (IMergeConflict.appearance). */
export interface IAppearanceConflictInfo {
  /** The material (merged name), for material-property conflicts. */
  material?: string;
  /** The conflicting properties (e.g. 'baseColorFactor', 'normalTexture', 'extensions.KHR_materials_unlit'). */
  properties?: string[];
  /** The UV set, for uv-layout / uv-overlap conflicts. */
  uvSet?: number;
  /** Faces whose appearance the conflict decides (base faces and added faces). */
  faces: number;
}

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
  /**
   * Present on appearance conflicts (material-property, material-assignment, uv-layout, uv-overlap).
   * They follow the geometry conflicts in id order; `baseFaces` / `baseVertices` list the base faces
   * involved (for a material: the faces using it) and the vertex fields are derived from them.
   */
  appearance?: IAppearanceConflictInfo;
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
  /**
   * Merge materials, UVs and texture references (docs/appearance-merge-design.md). Default true;
   * it runs only when base, ours and theirs all carry appearance data (`IMesh.appearance`, glTF).
   */
  mergeAppearance?: boolean;
  /** UV difference (in UV units, per coordinate) above which a corner counts as changed. Default 2⁻¹⁶. */
  uvEpsilon?: number;
}

/**
 * Damage that only the chosen COMBINATION of resolutions creates (each resolution is fine on its
 * own): e.g. one region resolved 'ours' pushes a wall into geometry another region took from
 * 'theirs'. Reported, never auto-fixed: the resolutions were explicit choices.
 */
export interface IMergeWarning {
  /** collision: surfaces cross / fold; uv-overlap: islands now overlap in texture space on a common image. */
  kind: 'collision' | 'uv-overlap';
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
  /** The appearance merge (materials, UVs, textures), when it ran: base, ours and theirs all carry appearance. */
  appearance?: IAppearanceMerge;
  /** The correspondences the merge was computed from. */
  ours: IDiffResult;
  theirs: IDiffResult;
  durationMs: number;
}

/** Counts of the appearance merge (auto-applied changes are counted whatever the resolutions). */
export interface IAppearanceMergeStats {
  /** Materials in the merged mesh. */
  materials: number;
  /** Material properties (texture slots included) taken from ours / theirs / identical on both. */
  propertiesFromOurs: number;
  propertiesFromTheirs: number;
  propertiesConvergent: number;
  /** Base faces whose material assignment was taken from ours / theirs / identical on both. */
  facesReassignedFromOurs: number;
  facesReassignedFromTheirs: number;
  facesReassignedConvergent: number;
  /** Base faces whose UVs were taken from ours / theirs / identical on both (whole islands). */
  uvFacesFromOurs: number;
  uvFacesFromTheirs: number;
  uvFacesConvergent: number;
  /** Appearance conflicts (appearance-geometry ones are counted with the geometry regions). */
  conflicts: number;
  unresolved: number;
}

export interface IAppearanceMerge {
  stats: IAppearanceMergeStats;
  /**
   * Per merged face: bitmask of the sides whose appearance edit (material assignment or UVs) it
   * carries: 1 = ours, 2 = theirs. Added faces carry their own side's bit.
   */
  faceChangedBy: Uint8Array;
  /** Per merged face: id of the appearance conflict deciding its material or UVs (-1 = none). */
  faceConflict: Int32Array;
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
