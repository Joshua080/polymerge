import { boundsDiagonal, computeMetrics, createMesh, describeSurface, formatMeasure, stepInfo, type IMesh, type IMeshMetrics } from 'polymerge-core';
import { loadMeshFile } from '../io.js';
import { fmt, formatMetricsLines, formatSize, palette } from '../report.js';

export interface InfoOptions {
  json?: boolean;
}

function stepLines(mesh: IMesh): string[] {
  const s = stepInfo(mesh);
  if (!s) return [];
  const lines = [
    `  STEP          ${s.solids} solid(s), ${s.brepFaces} B-rep face(s), in mm`,
    `  tessellation  OpenCascade, deflection ${s.deflection} mm, angular ${s.angularDeflection} rad`,
  ];
  const faces = mesh.brep?.faces ?? [];
  if (faces.length > 0) {
    // "6 flat faces, 2 holes Ø8, 4 outer rounds r5": the CAD faces, grouped by what they are.
    const counts = new Map<string, number>();
    for (const f of faces) {
      // Group flat faces whatever way they face.
      const what = describeSurface(f.surface).replace(/ facing [+−-][XYZ]$/, '');
      counts.set(what, (counts.get(what) ?? 0) + 1);
    }
    const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    lines.push(`  CAD faces     ${kinds.slice(0, 8).map(([what, n]) => `${n} × ${what}`).join(', ')}${kinds.length > 8 ? ', …' : ''}`);
  }
  return lines;
}

/** The faces of one group as a mesh of its own, with only the vertices they use (for per-part metrics). */
function groupMesh(mesh: IMesh, g: number): IMesh {
  const { faceStart, faceCount } = mesh.groups[g];
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const faces = new Uint32Array(faceCount * 3);
  for (let i = 0; i < faceCount * 3; i++) {
    const v = mesh.faces[faceStart * 3 + i];
    let r = remap.get(v);
    if (r === undefined) {
      r = remap.size;
      remap.set(v, r);
      positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    }
    faces[i] = r;
  }
  return createMesh(positions, faces, { metadata: { format: mesh.metadata.format } });
}

/** Per part: size, volume (closed parts) and faces. */
function partLines(mesh: IMesh, limit = 40): string[] {
  if (mesh.groups.length < 2) return [];
  const out = [`  parts (${mesh.groups.length})`];
  for (const [g, group] of mesh.groups.slice(0, limit).entries()) {
    const m = computeMetrics(groupMesh(mesh, g));
    const volume = m.volume !== null ? `volume ${formatMeasure(m.volume, 3, m.unit)}` : 'open surface';
    out.push(`    - ${group.name}: ${group.faceCount} faces, ${formatSize(m.size, m.unit)}, ${volume}`);
  }
  if (mesh.groups.length > limit) out.push(`    … ${mesh.groups.length - limit} more`);
  return out;
}

/** Everything `info` shows, as JSON. */
function infoJson(fileName: string, mesh: IMesh, metrics: IMeshMetrics): unknown {
  const m = mesh.metadata;
  return {
    file: fileName,
    format: m.format,
    vertices: mesh.vertexCount,
    faces: mesh.faceCount,
    source: { vertices: m.sourceVertexCount, faces: m.sourceFaceCount, degenerateFacesDropped: m.degenerateFacesDropped, weldEpsilon: m.weldEpsilon },
    bounds: m.bounds,
    metrics,
    vertexIds: !!mesh.vertexIds,
    groups: mesh.groups.map((g, i) => ({ name: g.name, faceStart: g.faceStart, faceCount: g.faceCount, metrics: mesh.groups.length > 1 ? computeMetrics(groupMesh(mesh, i)) : undefined })),
    materials: mesh.materials.map((mat) => ({ name: mat.name, color: mat.color })),
    step: stepInfo(mesh) ?? undefined,
    cadFaces: mesh.brep?.faces.map((f) => ({ group: f.group, surface: f.surface, description: describeSurface(f.surface), triangles: f.triangles, area: f.area, centroid: f.centroid })),
    warnings: m.warnings,
  };
}

/** `polymerge info <file>` — print the normalised mesh summary. */
export async function runInfo(filePath: string, o: InfoOptions = {}): Promise<number> {
  const { mesh, fileName } = await loadMeshFile(filePath);
  const metrics = computeMetrics(mesh);
  if (o.json) {
    process.stdout.write(JSON.stringify(infoJson(fileName, mesh, metrics), null, 2) + '\n');
    return 0;
  }
  const c = palette();
  const m = mesh.metadata;
  const lines = [
    c.bold(fileName),
    `  format        ${m.format.toUpperCase()}`,
    `  vertices      ${mesh.vertexCount} welded (${m.sourceVertexCount} from loader, weld ε=${m.weldEpsilon})`,
    `  faces         ${mesh.faceCount} (${m.sourceFaceCount} from loader, ${m.degenerateFacesDropped} degenerate dropped)`,
    `  bounds        min (${m.bounds.min.map((x) => fmt(x)).join(', ')})  max (${m.bounds.max.map((x) => fmt(x)).join(', ')})  diag ${fmt(boundsDiagonal(m.bounds))}`,
    `  vertex IDs    ${mesh.vertexIds ? 'yes' : 'no'}`,
    ...formatMetricsLines(metrics),
    ...stepLines(mesh),
    ...partLines(mesh),
    `  groups (${mesh.groups.length})`,
    ...mesh.groups.map((g) => `    - ${g.name}: faces ${g.faceStart}..${g.faceStart + g.faceCount - 1}`),
  ];
  if (mesh.materials.length) {
    lines.push(`  materials (${mesh.materials.length})`, ...mesh.materials.map((mat) => `    - ${mat.name || '(unnamed)'}`));
  }
  if (m.warnings.length) lines.push(`  warnings`, ...m.warnings.map((w) => `    ! ${c.modified(w)}`));
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
