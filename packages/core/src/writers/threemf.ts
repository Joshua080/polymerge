/**
 * 3MF writer (used to save merge results): a minimal package with the core specification only —
 * one object per group, the materials as one <basematerials> group, positions in millimetres.
 * Slicer project data (print settings, plates, thumbnails) is not written: polymerge's meshes do
 * not carry it, so a merged 3MF holds the geometry and colours only.
 */
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { MODEL_REL } from '../parsers/threemf.js';
import type { IMesh } from '../types.js';
import { formatFloat32 } from './float.js';

export function writeThreeMf(mesh: IMesh, opts: { name?: string } = {}): Uint8Array {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = formatFloat32;
  const srgbHex = (c: number): string => {
    const v = Math.min(1, Math.max(0, c));
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(s * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  };
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  out.push(` <metadata name="Application">polymerge</metadata>`);
  if (opts.name) out.push(` <metadata name="Title">${esc(opts.name)}</metadata>`);
  out.push(' <resources>');
  const hasMaterials = mesh.materials.length > 0 && !!mesh.faceMaterials;
  const materialId = 1;
  if (hasMaterials) {
    out.push(`  <basematerials id="${materialId}">`);
    for (const m of mesh.materials) {
      const c = m.color ?? [0.8, 0.8, 0.8, 1];
      const alpha = c[3] < 1 ? Math.round(c[3] * 255).toString(16).padStart(2, '0').toUpperCase() : '';
      out.push(`   <base name="${esc(m.name)}" displaycolor="#${srgbHex(c[0])}${srgbHex(c[1])}${srgbHex(c[2])}${alpha}"/>`);
    }
    out.push('  </basematerials>');
  }
  const p = mesh.positions;
  const f = mesh.faces;
  const objectIds: number[] = [];
  let nextId = hasMaterials ? 2 : 1;
  for (const g of mesh.groups) {
    if (g.faceCount === 0) continue;
    const id = nextId++;
    objectIds.push(id);
    // Re-index the group's vertices locally (each 3MF object has its own vertex list).
    const local = new Map<number, number>();
    const verts: string[] = [];
    const tris: string[] = [];
    for (let k = g.faceStart; k < g.faceStart + g.faceCount; k++) {
      const idx: number[] = [];
      for (let c = 0; c < 3; c++) {
        const v = f[k * 3 + c];
        let li = local.get(v);
        if (li === undefined) {
          li = local.size;
          local.set(v, li);
          verts.push(`     <vertex x="${num(p[v * 3])}" y="${num(p[v * 3 + 1])}" z="${num(p[v * 3 + 2])}"/>`);
        }
        idx.push(li);
      }
      const m = hasMaterials ? mesh.faceMaterials![k] : -1;
      tris.push(`     <triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"${m >= 0 ? ` pid="${materialId}" p1="${m}"` : ''}/>`);
    }
    out.push(`  <object id="${id}" type="model" name="${esc(g.name)}">`);
    out.push('   <mesh>', '    <vertices>', ...verts, '    </vertices>', '    <triangles>', ...tris, '    </triangles>', '   </mesh>');
    out.push('  </object>');
  }
  out.push(' </resources>', ' <build>');
  for (const id of objectIds) out.push(`  <item objectid="${id}"/>`);
  out.push(' </build>', '</model>');

  const enc = new TextEncoder();
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>\n';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${MODEL_REL}"/>` +
    '</Relationships>\n';
  // A fixed time stamp, built from LOCAL fields (the ZIP format stores local time), so the same
  // mesh always gives the same bytes in any time zone.
  const mtime = new Date(1980, 0, 1, 0, 0, 0);
  return zipSync(
    {
      '[Content_Types].xml': [enc.encode(contentTypes), { level: 6, mtime }],
      '_rels/.rels': [enc.encode(rels), { level: 6, mtime }],
      '3D/3dmodel.model': [enc.encode(out.join('\n') + '\n'), { level: 6, mtime }],
    },
    { mtime },
  );
}

