/**
 * Mesh writers: shortest float32 formatting and exact round trips through the real loaders.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { loadMesh } from '../../src/parsers/index.js';
import { createMesh } from '../../src/mesh.js';
import { formatFloat32, writeMesh, writeObj, writeStl } from '../../src/writers/index.js';
import type { SourceFormat } from '../../src/types.js';
import { asymmetricSolid, silent } from '../diff/util.js';

describe('writers', () => {
  it('formats the shortest decimal that round-trips through float32', () => {
    expect(formatFloat32(0)).toBe('0');
    expect(formatFloat32(-0)).toBe('0');
    expect(formatFloat32(1)).toBe('1');
    expect(formatFloat32(0.1)).toBe('0.1');
    expect(formatFloat32(25.4)).toBe('25.4');
    expect(formatFloat32(1 / 3)).toBe('0.33333334');
    for (const x of [Math.PI, -1e-7, 123456.789, 1e30]) expect(Math.fround(Number(formatFloat32(x)))).toBe(Math.fround(x));
    expect(() => formatFloat32(Number.NaN)).toThrow();
  });

  const solid = asymmetricSolid(12, 6);
  const f32 = createMesh(solid.positions.map((v) => Math.fround(v)), solid.faces, {
    groups: [
      { name: 'upper', faceStart: 0, faceCount: 60 },
      { name: 'lower', faceStart: 60, faceCount: solid.faceCount - 60 },
    ],
  });

  for (const [label, bytes, name] of [
    ['OBJ', writeObj(f32), 'm.obj'],
    ['binary STL', writeStl(f32), 'm.stl'],
    ['ASCII STL', writeStl(f32, { binary: false }), 'm.stl'],
  ] as const) {
    it(`${label} round-trips exactly through loadMesh`, async () => {
      const back = await loadMesh(bytes, { fileName: name });
      expect(back.vertexCount).toBe(f32.vertexCount);
      expect(back.faceCount).toBe(f32.faceCount);
      const d = diffMeshes(f32, back, { logger: silent });
      expect(d.stats.vertices).toEqual({ unchanged: f32.vertexCount, moved: 0, added: 0, removed: 0 });
      expect(d.stats.faces.unchanged).toBe(f32.faceCount);
    });
  }

  it('OBJ keeps group names; binary STL headers never start with "solid"', async () => {
    const back = await loadMesh(writeObj(f32), { fileName: 'm.obj' });
    expect(back.groups.map((g) => g.name)).toEqual(['upper', 'lower']);
    const stl = writeStl(f32, { name: 'solid thing' });
    expect(new TextDecoder().decode(stl.subarray(0, 5))).not.toBe('solid');
    expect(stl.length).toBe(84 + 50 * f32.faceCount);
  });

  it('writeMesh writes every source format and rejects anything else', () => {
    expect(() => writeMesh(f32, 'step')).toThrow(/not supported/);
    for (const format of ['obj', 'stl', 'glb', 'gltf', 'ply', '3mf'] as const) expect(writeMesh(f32, format).length).toBeGreaterThan(0);
  });
});
