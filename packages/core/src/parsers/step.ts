/**
 * STEP (ISO 10303-21) → IMesh, through an INJECTED importer.
 *
 * STEP stores a B-rep: exact analytic / NURBS surfaces trimmed by edge loops. Turning that into
 * triangles needs a geometry kernel, which polymerge does not contain: the caller passes one in
 * (`ILoadOptions.step.importer`), in practice OpenCascade from the optional `occt-import-js`
 * package (LGPL-2.1, ~8 MB of wasm). polymerge-core itself stays dependency-free.
 *
 * Tessellation:
 *  - Always in millimetres: the importer converts inch / metre / ... files.
 *  - The linear deflection (the largest distance between a triangle and the true surface) is an
 *    ABSOLUTE length, never a fraction of the model's size: two versions of a part must be
 *    tessellated with the same tolerance, or surfaces that did not change get different triangles
 *    and show up as edits. The caller passes the base's value for the other version; without
 *    one it is derived from this model's own size ({@link stepDeflectionFor}), which costs one
 *    extra coarse tessellation to measure the model first.
 *  - Deterministic: the same bytes and parameters give the same triangles.
 *
 * Mapping (into ./weld.ts, like every other format):
 *  - One TrianglePart (→ IMeshGroup) per importer mesh, i.e. per solid or free shell, in the
 *    importer's order. Positions are already in world space (assembly placements applied).
 *  - Group name: the solid's name in the file, else the name of the assembly node holding it,
 *    else the file's base name; a repeated name gets " #2", " #3", ... (assemblies repeat parts).
 *  - Colours become materials ("#rrggbb", sRGB hex of the linear colour): a B-rep face's own
 *    colour, else its solid's. Uncoloured faces have no material.
 *  - Faces of one B-rep face are welded to their neighbours exactly (shared edges are discretised
 *    once), so a closed solid loads as a closed mesh.
 */
import { boundsDiagonal, defaultGroupName } from '../mesh.js';
import {
  MeshLoadError,
  type IBounds,
  type IMaterial,
  type IMesh,
  type IStepImportMesh,
  type IStepImportNode,
  type IStepImportParams,
  type IStepImportResult,
  type IStepInfo,
  type IStepLoadOptions,
} from '../types.js';
import { namePrefix, type FormatLoadContext } from './bytes.js';
import { buildWeldedMesh, type TrianglePart } from './weld.js';

/** Default deflection: this fraction of the bounding-box diagonal, rounded down to 1, 2 or 5 × 10ⁿ mm. */
export const STEP_DEFLECTION_RATIO = 1 / 2000;
/** Default angular deflection, radians (OpenCascade's own default). */
export const STEP_ANGULAR_DEFLECTION = 0.5;
/** Ratio for the coarse pass that only measures the model. */
const MEASURE_RATIO = 0.02;

/**
 * The default linear deflection for a model with these bounds: {@link STEP_DEFLECTION_RATIO} of
 * the diagonal, rounded DOWN to 1, 2 or 5 × 10ⁿ. Round numbers read well in reports, and two
 * versions of similar size usually land on the same value even when measured separately.
 */
export function stepDeflectionFor(bounds: IBounds): number {
  const target = boundsDiagonal(bounds) * STEP_DEFLECTION_RATIO;
  if (!(target > 0) || !Number.isFinite(target)) return 0.01;
  const decade = 10 ** Math.floor(Math.log10(target));
  const step = [5, 2, 1].find((m) => m * decade <= target * (1 + 1e-9)) ?? 1;
  // Strip float noise (0.1 * 5 = 0.5000000000000001).
  return Number((step * decade).toPrecision(6));
}

/** The tessellation a STEP-loaded mesh records, or undefined for any other mesh. */
export function stepInfo(mesh: IMesh): IStepInfo | undefined {
  if (mesh.metadata.format !== 'step') return undefined;
  const info = mesh.metadata.extras?.step as IStepInfo | undefined;
  return info && typeof info.deflection === 'number' ? info : undefined;
}

function positiveOption(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MeshLoadError(`step.${name} must be a finite number > 0 (got ${String(value)})`, 'step');
  }
  return value;
}

function read(content: Uint8Array, options: IStepLoadOptions, params: IStepImportParams, prefix: string): IStepImportResult & { meshes: IStepImportMesh[] } {
  const result: IStepImportResult = options.importer.ReadStepFile(content, { linearUnit: 'millimeter', ...params });
  if (!result || !result.success) throw new MeshLoadError(`${prefix}OpenCascade could not read this file as STEP`, 'step');
  return { ...result, meshes: result.meshes ?? [] };
}

const NO_SURFACES = 'the STEP file contains no surfaces (no solids, shells or faces to show)';

/** Bounds of every vertex the importer produced (null when there is none). */
function vertexBounds(meshes: readonly IStepImportMesh[]): IBounds | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.attributes?.position?.array ?? [];
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const x = p[i + a];
        if (!Number.isFinite(x)) continue;
        if (x < min[a]) min[a] = x;
        if (x > max[a]) max[a] = x;
      }
    }
  }
  return min.every(Number.isFinite) ? { min: min as IBounds['min'], max: max as IBounds['max'] } : null;
}

/** Name of the assembly node that holds each mesh (first holder wins). */
function holderNames(root: IStepImportNode | undefined, count: number): (string | undefined)[] {
  const names = new Array<string | undefined>(count).fill(undefined);
  const walk = (node: IStepImportNode | undefined, depth: number): void => {
    if (!node || depth > 256) return;
    for (const i of node.meshes ?? []) if (i >= 0 && i < count && names[i] === undefined && node.name) names[i] = node.name;
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return names;
}

/** Linear [0, 1] → sRGB-encoded byte. */
function srgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function isColor(c: readonly number[] | null | undefined): c is readonly number[] {
  return !!c && c.length >= 3 && [c[0], c[1], c[2]].every((x) => typeof x === 'number' && Number.isFinite(x));
}

export function loadStep(buffer: ArrayBuffer, ctx: FormatLoadContext, options: IStepLoadOptions | undefined): IMesh {
  const prefix = namePrefix(ctx.fileName);
  if (!options || typeof options.importer?.ReadStepFile !== 'function') {
    throw new MeshLoadError(
      `${prefix}STEP files are tessellated by OpenCascade, which is an optional download: ` +
        'install the occt-import-js package (LGPL-2.1, about 8 MB) next to polymerge, or pass options.step.importer',
      'step',
    );
  }
  const angularDeflection = positiveOption('angularDeflection', options.angularDeflection) ?? STEP_ANGULAR_DEFLECTION;
  let deflection = positiveOption('deflection', options.deflection);
  const content = new Uint8Array(buffer);

  if (deflection === undefined) {
    // Measure the model with a coarse pass, then tessellate it for real with an absolute value.
    const coarse = read(content, options, { linearDeflectionType: 'bounding_box_ratio', linearDeflection: MEASURE_RATIO, angularDeflection }, prefix);
    const bounds = vertexBounds(coarse.meshes);
    if (!bounds) throw new MeshLoadError(`${prefix}${NO_SURFACES}`, 'step');
    deflection = stepDeflectionFor(bounds);
  }
  const { meshes, root } = read(content, options, { linearDeflectionType: 'absolute_value', linearDeflection: deflection, angularDeflection }, prefix);
  if (meshes.length === 0) throw new MeshLoadError(`${prefix}${NO_SURFACES}`, 'step');
  const holders = holderNames(root, meshes.length);
  return toMesh(meshes, holders, { ...ctx, fallback: defaultGroupName(ctx.fileName), deflection, angularDeflection });
}

interface ConvertContext extends FormatLoadContext {
  fallback: string;
  deflection: number;
  angularDeflection: number;
}

function toMesh(meshes: readonly IStepImportMesh[], holders: readonly (string | undefined)[], ctx: ConvertContext): IMesh {
  const materials: IMaterial[] = [];
  const byColor = new Map<string, number>();
  const material = (c: readonly number[] | null | undefined): number => {
    if (!isColor(c)) return -1;
    const hex = `#${[c[0], c[1], c[2]].map((x) => srgbByte(x).toString(16).padStart(2, '0')).join('')}`;
    let index = byColor.get(hex);
    if (index === undefined) {
      index = materials.length;
      byColor.set(hex, index);
      materials.push({ name: hex, color: [c[0], c[1], c[2], 1].map((x) => Math.min(1, Math.max(0, x))) as IMaterial['color'] });
    }
    return index;
  };

  const used = new Map<string, number>();
  const unique = (name: string): string => {
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    return n === 1 ? name : `${name} #${n}`;
  };

  const parts: TrianglePart[] = [];
  let brepFaces = 0;
  meshes.forEach((m, i) => {
    const positions = m.attributes?.position?.array ?? [];
    const indices = m.index?.array ?? [];
    const triangles = Math.floor(indices.length / 3);
    const solidMaterial = material(m.color);
    const faces = m.brep_faces ?? [];
    brepFaces += faces.length;
    let faceMaterials: Int32Array | null = null;
    if (faces.some((f) => isColor(f.color))) {
      faceMaterials = new Int32Array(triangles).fill(solidMaterial);
      for (const f of faces) {
        if (!isColor(f.color)) continue;
        const own = material(f.color);
        for (let t = Math.max(0, f.first); t <= Math.min(triangles - 1, f.last); t++) faceMaterials[t] = own;
      }
    }
    parts.push({
      name: unique(m.name || holders[i] || ctx.fallback),
      positions,
      indices,
      material: solidMaterial,
      faceMaterials,
    });
  });

  const info: IStepInfo = { deflection: ctx.deflection, angularDeflection: ctx.angularDeflection, unit: 'mm', solids: meshes.length, brepFaces };
  return buildWeldedMesh({
    format: 'step',
    parts,
    materials,
    fileName: ctx.fileName,
    weldEpsilon: ctx.weldEpsilon,
    extras: { step: info },
  });
}
