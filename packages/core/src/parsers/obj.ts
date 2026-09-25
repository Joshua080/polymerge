/**
 * OBJ → IMesh via three.js' OBJLoader.
 *
 * OBJLoader returns a Group whose children (one per `o` / `g` statement that has
 * geometry, in file order) are Mesh / LineSegments / Points with NON-indexed geometry;
 * n-gons are fan-triangulated (v0 v1 v2, v0 v2 v3, …). A child with several `usemtl`
 * runs gets an array material plus `geometry.groups`.
 *
 * Mapping: one TrianglePart (→ IMeshGroup) per Mesh child, named `child.name` or, when
 * unnamed, the file base name / "default" (same fallback as every other format). No .mtl
 * file is available, so materials are identified by their `usemtl` NAME only
 * (`IMaterial { name }`; OBJLoader's placeholder colours are not reported). Faces with
 * no `usemtl` get material -1. Lines and points are skipped with a warning.
 */
import type { Group, Material, Mesh, Object3D } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { defaultGroupName } from '../mesh.js';
import { MeshLoadError, type IMaterial, type IMesh } from '../types.js';
import { decodeUtf8, namePrefix, type FormatLoadContext } from './bytes.js';
import { meshToPart } from './three-mesh.js';
import { buildWeldedMesh, type TrianglePart } from './weld.js';

function describe(kind: string, names: string[]): string {
  const shown = names.slice(0, 5).map((n) => `"${n}"`);
  if (names.length > 5) shown.push('…');
  return `${names.length} ${kind} object(s) (${shown.join(', ')})`;
}

export function loadObj(buffer: ArrayBuffer, ctx: FormatLoadContext): IMesh {
  const prefix = namePrefix(ctx.fileName);
  const fallbackName = defaultGroupName(ctx.fileName);
  const root: Group & { materialLibraries?: string[] } = new OBJLoader().parse(decodeUtf8(buffer));
  root.updateMatrixWorld(true);

  const warnings: string[] = [];
  const materials: IMaterial[] = [];
  const byName = new Map<string, number>();
  const resolveMaterial = (m: Material | undefined): number => {
    const name = m?.name ?? '';
    if (!name) return -1;
    let index = byName.get(name);
    if (index === undefined) {
      index = materials.length;
      byName.set(name, index);
      materials.push({ name });
    }
    return index;
  };

  const parts: TrianglePart[] = [];
  const skippedLines: string[] = [];
  const skippedPoints: string[] = [];
  root.traverse((obj: Object3D) => {
    if (obj === root) return;
    const label = obj.name || fallbackName;
    if ((obj as Mesh).isMesh) {
      const info = meshToPart(obj as Mesh, { name: label, resolveMaterial });
      if (info) parts.push(info.part);
    } else if ((obj as { isLine?: boolean }).isLine) skippedLines.push(label);
    else if ((obj as { isPoints?: boolean }).isPoints) skippedPoints.push(label);
  });

  const skipped: string[] = [];
  if (skippedLines.length) skipped.push(describe('line', skippedLines));
  if (skippedPoints.length) skipped.push(describe('point', skippedPoints));
  if (skipped.length) {
    const note = skippedLines.length
      ? ' (OBJLoader turns an object that contains any `l` statement into a line object)'
      : '';
    warnings.push(`skipped ${skipped.join(' and ')}: only triangle faces are kept${note}`);
  }
  if (parts.length === 0) {
    throw new MeshLoadError(
      `${prefix}OBJ contains no triangle faces${skipped.length ? ` (${skipped.join(', ')})` : ''}`,
      'obj',
    );
  }

  return buildWeldedMesh({
    format: 'obj',
    parts,
    materials,
    fileName: ctx.fileName,
    weldEpsilon: ctx.weldEpsilon,
    warnings,
    extras: { materialLibraries: [...(root.materialLibraries ?? [])] },
  });
}
