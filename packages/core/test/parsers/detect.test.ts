import { describe, expect, it } from 'vitest';
import { detectFormat, formatFromFileName, sniffFormat } from '../../src/parsers/index.js';
import { MeshLoadError } from '../../src/types.js';
import { asciiStl, binaryStl, buildGltf, cubeTriangles, CUBE_CORNERS, CUBE_TRIS, glbBytes, gltfText, objText, utf8 } from './helpers.js';

const cubeGltf = buildGltf({
  meshes: [{ primitives: [{ positions: CUBE_CORNERS.flat(), indices: CUBE_TRIS.flat() }] }],
  nodes: [{ mesh: 0 }],
});

describe('detectFormat — by extension', () => {
  it.each([
    ['part.stl', 'stl'],
    ['PART.STL', 'stl'],
    ['dir/sub/model.Obj', 'obj'],
    ['C:\\models\\scene.GLTF', 'gltf'],
    ['https://example.com/a/b/scene.glb?raw=1#x', 'glb'],
    ['archive.v2.glb', 'glb'],
  ] as const)('%s → %s', (name, format) => {
    expect(formatFromFileName(name)).toBe(format);
    // Extension wins even when the content says otherwise.
    expect(detectFormat(utf8('garbage'), name)).toBe(format);
  });

  it('ignores unknown extensions and falls back to sniffing', () => {
    expect(formatFromFileName('notes.txt')).toBeUndefined();
    expect(formatFromFileName('stl')).toBeUndefined();
    expect(formatFromFileName(undefined)).toBeUndefined();
    expect(detectFormat(binaryStl(cubeTriangles()), 'mesh.bin')).toBe('stl');
    expect(detectFormat(utf8(objText(CUBE_CORNERS, CUBE_TRIS)), 'noext')).toBe('obj');
  });
});

describe('detectFormat — by content', () => {
  it('GLB magic', () => {
    expect(detectFormat(glbBytes(cubeGltf))).toBe('glb');
  });

  it('JSON glTF (with BOM / leading whitespace)', () => {
    expect(detectFormat(utf8(gltfText(cubeGltf)))).toBe('gltf');
    expect(detectFormat(utf8('\uFEFF  \n' + gltfText(cubeGltf)))).toBe('gltf');
  });

  it('binary STL by exact size, even when the header starts with "solid" or "{"', () => {
    const tris = cubeTriangles();
    expect(detectFormat(binaryStl(tris))).toBe('stl');
    expect(detectFormat(binaryStl(tris, { header: 'solid exported by CAD' }))).toBe('stl');
    expect(detectFormat(binaryStl(tris, { header: '{ not json' }))).toBe('stl');
  });

  it('ASCII STL: "solid" followed by "facet"', () => {
    expect(detectFormat(utf8(asciiStl([{ name: 'x', tris: cubeTriangles() }])))).toBe('stl');
    expect(detectFormat(utf8(asciiStl([{ tris: cubeTriangles() }], '\r\n')))).toBe('stl');
    expect(sniffFormat(utf8('solid but then nothing that looks like facets'))).toBeUndefined();
  });

  it('OBJ: v lines plus f lines (comments, groups, CRLF)', () => {
    expect(detectFormat(utf8(objText(CUBE_CORNERS, CUBE_TRIS, ['# exported', 'mtllib a.mtl', 'o Cube'])))).toBe('obj');
    expect(detectFormat(utf8(objText(CUBE_CORNERS, CUBE_TRIS).replace(/\n/g, '\r\n')))).toBe('obj');
    expect(sniffFormat(utf8('v 1 2 3\nv 4 5 6\n'))).toBeUndefined(); // vertices only
  });

  it('OBJ whose first face line is beyond the sniff window', () => {
    const verts = Array.from({ length: 5000 }, (_, i) => `v ${i} ${i * 0.5} -${i}.25`).join('\n');
    const text = `${verts}\nf 1 2 3\n`;
    expect(text.length).toBeGreaterThan(64 * 1024);
    expect(detectFormat(utf8(text))).toBe('obj');
  });

  it('honours a Uint8Array view with a non-zero byteOffset', () => {
    const stl = binaryStl(cubeTriangles());
    const host = new Uint8Array(stl.length + 17);
    host.set(stl, 13);
    expect(detectFormat(host.subarray(13, 13 + stl.length))).toBe('stl');
    expect(sniffFormat(host)).toBeUndefined();
  });

  it('accepts an ArrayBuffer', () => {
    const glb = glbBytes(cubeGltf).slice();
    expect(detectFormat(glb.buffer)).toBe('glb');
  });

  it('throws MeshLoadError for unknown or empty content', () => {
    expect(() => detectFormat(utf8('hello world, not a mesh'))).toThrow(MeshLoadError);
    expect(() => detectFormat(new Uint8Array(0))).toThrow(/empty/);
    expect(() => detectFormat(new Uint8Array([1, 2, 3, 4, 5]), 'blob.dat')).toThrow(/blob\.dat: unknown mesh format/);
  });
});
