import { boundsDiagonal } from '@polymerge/core';
import { loadMeshFile } from '../io.js';
import { fmt, palette } from '../report.js';

/** `polymerge info <file>` — print the normalised mesh summary. */
export async function runInfo(filePath: string): Promise<number> {
  const { mesh, fileName } = await loadMeshFile(filePath);
  const c = palette();
  const m = mesh.metadata;
  const lines = [
    c.bold(fileName),
    `  format        ${m.format.toUpperCase()}`,
    `  vertices      ${mesh.vertexCount} welded (${m.sourceVertexCount} from loader, weld ε=${m.weldEpsilon})`,
    `  faces         ${mesh.faceCount} (${m.sourceFaceCount} from loader, ${m.degenerateFacesDropped} degenerate dropped)`,
    `  bounds        min (${m.bounds.min.map((x) => fmt(x)).join(', ')})  max (${m.bounds.max.map((x) => fmt(x)).join(', ')})  diag ${fmt(boundsDiagonal(m.bounds))}`,
    `  vertex IDs    ${mesh.vertexIds ? 'yes' : 'no'}`,
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
