import { describe, expect, it } from 'vitest';
import { loadMesh } from '../../src/parsers/index.js';
import { cleanSolidName } from '../../src/parsers/stl.js';
import { MeshLoadError, type Vec3 } from '../../src/types.js';
import {
  asciiStl,
  binaryStl,
  CUBE_EXPECTED_FACES,
  CUBE_EXPECTED_POSITIONS,
  cubeTriangles,
  utf8,
  type Tri,
} from './helpers.js';

describe('STL — cube', () => {
  it('ASCII cube: 8 vertices / 12 faces in exact first-appearance order', async () => {
    const mesh = await loadMesh(utf8(asciiStl([{ name: 'cube', tris: cubeTriangles() }])), { fileName: 'cube.stl' });
    expect(mesh.vertexCount).toBe(8);
    expect(mesh.faceCount).toBe(12);
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups).toEqual([{ name: 'cube', faceStart: 0, faceCount: 12 }]);
    expect(mesh.metadata).toMatchObject({
      format: 'stl',
      sourceName: 'cube.stl',
      sourceVertexCount: 36,
      sourceFaceCount: 12,
      degenerateFacesDropped: 0,
      weldEpsilon: 0,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      warnings: [],
      extras: { encoding: 'ascii', solidNames: ['cube'] },
    });
  });

  it('binary cube: identical arrays, default group named after the file', async () => {
    const mesh = await loadMesh(binaryStl(cubeTriangles()), { fileName: 'models/Bracket_v2.stl' });
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups).toEqual([{ name: 'Bracket_v2', faceStart: 0, faceCount: 12 }]);
    expect(mesh.metadata.extras).toEqual({
      encoding: 'binary',
      header: 'binary stl written by polymerge tests',
      hasColors: false,
    });
    expect(mesh.materials).toEqual([]);
    expect(mesh.faceMaterials).toBeUndefined();
  });

  it('CRLF ASCII and a group name of "default" without a file name', async () => {
    const mesh = await loadMesh(utf8(asciiStl([{ tris: cubeTriangles() }], '\r\n')));
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups[0].name).toBe('default');
    expect(mesh.metadata.sourceName).toBeUndefined();
  });
});

describe('STL — structure', () => {
  it('multi-solid ASCII → one group per solid, names cleaned', async () => {
    const text = asciiStl([
      { name: 'base plate', tris: cubeTriangles() },
      { tris: cubeTriangles([2, 0, 0]) },
      { name: 'lid', tris: cubeTriangles([0, 0, 2]).slice(0, 2) },
    ]);
    const mesh = await loadMesh(utf8(text), { fileName: 'asm.stl' });
    expect(mesh.groups).toEqual([
      { name: 'base plate', faceStart: 0, faceCount: 12 },
      { name: 'asm', faceStart: 12, faceCount: 12 },
      { name: 'lid', faceStart: 24, faceCount: 2 },
    ]);
    expect(mesh.faceCount).toBe(26);
    expect(mesh.vertexCount).toBe(8 + 8 + 4);
    expect(mesh.metadata.extras).toEqual({ encoding: 'ascii', solidNames: ['base plate', '', 'lid'] });
  });

  it('cleanSolidName strips the loader capture artefacts', () => {
    expect(cleanSolidName('part\r')).toBe('part');
    expect(cleanSolidName('  facet normal 0 0 1')).toBe('');
    expect(cleanSolidName('endsolid')).toBe('');
    expect(cleanSolidName(undefined)).toBe('');
    expect(cleanSolidName('facets are fine as a word?')).toBe('facets are fine as a word?');
  });

  it('binary per-facet colours → materials + faceMaterials (linear RGBA), not groups', async () => {
    const tris = cubeTriangles();
    const header = 'COLOR=' + String.fromCharCode(255, 0, 0, 255) + ' MATERIAL=';
    const green = 31 << 5; // Magics layout: r = bits 0-4, g = 5-9, b = 10-14; bit 15 clear = own colour
    const blue = 31 << 10;
    const colors = tris.map((_, i) => (i < 4 ? green : i < 8 ? 0x8000 : blue));
    const mesh = await loadMesh(binaryStl(tris, { header, colors }), { fileName: 'painted.stl' });
    expect(mesh.groups).toHaveLength(1);
    expect(mesh.materials).toEqual([
      { name: 'color_00ff00', color: [0, 1, 0, 1] },
      { name: 'color_ff0000', color: [1, 0, 0, 1] },
      { name: 'color_0000ff', color: [0, 0, 1, 1] },
    ]);
    expect(Array.from(mesh.faceMaterials!)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
    expect(mesh.metadata.extras).toMatchObject({ encoding: 'binary', hasColors: true });
  });

  it('degenerate facets are dropped and counted; unreferenced vertices never appear', async () => {
    const tris: Tri[] = [
      [
        [9, 9, 9],
        [9, 9, 9],
        [0, 0, 0],
      ],
      ...cubeTriangles(),
      [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
    ];
    for (const bytes of [binaryStl(tris), utf8(asciiStl([{ name: 'd', tris }]))]) {
      const mesh = await loadMesh(bytes);
      expect(mesh.metadata.sourceFaceCount).toBe(14);
      expect(mesh.metadata.degenerateFacesDropped).toBe(2);
      expect(mesh.faceCount).toBe(12);
      expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
      expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    }
  });

  it('weldEpsilon merges near-duplicate STL corners', async () => {
    const a = cubeTriangles();
    const jittered = a.map((t, i) => (i % 2 ? (t.map((v) => v.map((x) => x + 1e-4)) as Tri) : t));
    const exact = await loadMesh(binaryStl(jittered));
    const welded = await loadMesh(binaryStl(jittered), { weldEpsilon: 1e-3 });
    expect(exact.vertexCount).toBeGreaterThan(8);
    expect(welded.vertexCount).toBe(8);
    expect(welded.faceCount).toBe(12);
    expect(welded.metadata.weldEpsilon).toBe(1e-3);
  });
});

describe('STL — robustness', () => {
  it('binary STL whose header starts with "solid" (exact size)', async () => {
    const mesh = await loadMesh(binaryStl(cubeTriangles(), { header: 'solid binary-but-says-solid' }), { fileName: 'x.stl' });
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.metadata.extras).toMatchObject({ encoding: 'binary' });
  });

  it('binary STL with trailing bytes (plain and "solid" header) loads with a warning', async () => {
    for (const header of ['plain header', 'solid misleading header']) {
      const mesh = await loadMesh(binaryStl(cubeTriangles(), { header, trailingBytes: 7 }), { fileName: 'x.stl' });
      expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
      expect(mesh.metadata.warnings.join()).toMatch(/7 trailing byte/);
    }
  });

  it('truncated binary STL → MeshLoadError (no giant allocation)', async () => {
    const full = binaryStl(cubeTriangles());
    await expect(loadMesh(full.subarray(0, full.length - 10), { fileName: 't.stl' })).rejects.toThrow(/truncated binary STL/);
    // Header claims ~4 billion triangles.
    const lying = binaryStl(cubeTriangles());
    new DataView(lying.buffer).setUint32(80, 0xffffffff, true);
    await expect(loadMesh(lying, { format: 'stl' })).rejects.toThrow(MeshLoadError);
  });

  it('tiny / empty / non-STL inputs → MeshLoadError', async () => {
    await expect(loadMesh(new Uint8Array(20), { format: 'stl' })).rejects.toThrow(/shorter than a binary STL header/);
    await expect(loadMesh(binaryStl([]), { fileName: 'empty.stl' })).rejects.toThrow(/no triangles/);
    await expect(loadMesh(utf8('solid x\nendsolid x\n'), { fileName: 'e.stl' })).rejects.toThrow(MeshLoadError);
    await expect(loadMesh(utf8('solid x\nendsolid x\n'))).rejects.toThrow(/no triangles/);
    await expect(loadMesh(new Uint8Array(0), { fileName: 'zero.stl' })).rejects.toThrow(/empty input/);
  });

  it('tiny single-facet ASCII file (< 84 bytes) loads (three reads offset 80 unconditionally)', async () => {
    const text = 'solid\nfacet normal 0 0 1\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendfacet\nendsolid';
    expect(text.length).toBeLessThan(84);
    const mesh = await loadMesh(utf8(text), { format: 'stl' });
    expect(mesh.faceCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('ASCII facet with a wrong vertex count → MeshLoadError', async () => {
    const v = (p: Vec3): string => `vertex ${p.join(' ')}`;
    const text = [
      'solid bad',
      'facet normal 0 0 1',
      'outer loop',
      v([0, 0, 0]),
      v([1, 0, 0]),
      'endloop',
      'endfacet',
      'endsolid bad',
    ].join('\n');
    await expect(loadMesh(utf8(text), { format: 'stl' })).rejects.toThrow(/malformed ASCII STL/);
  });
});
