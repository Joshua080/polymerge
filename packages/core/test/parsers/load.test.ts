import { describe, expect, it } from 'vitest';
import { detectFormat, loadMesh } from '../../src/parsers/index.js';
import { MeshLoadError, type SourceFormat } from '../../src/types.js';
import {
  arraysOf,
  asciiStl,
  binaryStl,
  buildGltf,
  CUBE_CORNERS,
  CUBE_EXPECTED_FACES,
  CUBE_EXPECTED_POSITIONS,
  CUBE_TRIS,
  cubeTriangles,
  glbBytes,
  gltfText,
  objText,
  soupPositions,
  trianglesOf,
  utf8,
} from './helpers.js';

/** The same cube, same face order, in every supported encoding. */
function cubeEncodings(): { name: string; format: SourceFormat; bytes: Uint8Array }[] {
  const tris = cubeTriangles();
  const indexed = buildGltf({ meshes: [{ primitives: [{ positions: CUBE_CORNERS.flat(), indices: CUBE_TRIS.flat() }] }], nodes: [{ mesh: 0 }] });
  const soup = buildGltf({ meshes: [{ primitives: [{ positions: soupPositions(trianglesOf(CUBE_CORNERS, CUBE_TRIS)) }] }], nodes: [{ mesh: 0 }] });
  return [
    { name: 'ascii.stl', format: 'stl', bytes: utf8(asciiStl([{ name: 'cube', tris }])) },
    { name: 'binary.stl', format: 'stl', bytes: binaryStl(tris) },
    { name: 'cube.obj', format: 'obj', bytes: utf8(objText(CUBE_CORNERS, CUBE_TRIS, ['o cube'])) },
    { name: 'indexed.glb', format: 'glb', bytes: glbBytes(indexed) },
    { name: 'soup.glb', format: 'glb', bytes: glbBytes(soup) },
    { name: 'embedded.gltf', format: 'gltf', bytes: utf8(gltfText(indexed)) },
  ];
}

describe('loadMesh — cross-format identity', () => {
  it('ASCII STL, binary STL, OBJ, GLB (indexed and not) and .gltf give identical positions and faces', async () => {
    for (const { name, format, bytes } of cubeEncodings()) {
      const mesh = await loadMesh(bytes, { fileName: name });
      expect(mesh.metadata.format, name).toBe(format);
      expect(arraysOf(mesh), name).toEqual({ positions: CUBE_EXPECTED_POSITIONS, faces: CUBE_EXPECTED_FACES });
      expect(mesh.vertexCount).toBe(8);
      expect(mesh.faceCount).toBe(12);
      expect(mesh.metadata.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    }
  });

  it('content sniffing alone (no file name) reaches the same result', async () => {
    for (const { format, bytes } of cubeEncodings()) {
      expect(detectFormat(bytes)).toBe(format);
      expect(arraysOf(await loadMesh(bytes))).toEqual({ positions: CUBE_EXPECTED_POSITIONS, faces: CUBE_EXPECTED_FACES });
    }
  });

  it('honours Uint8Array views with a non-zero byteOffset (and leaves the input untouched)', async () => {
    for (const { name, bytes } of cubeEncodings()) {
      const host = new Uint8Array(bytes.length + 64).fill(0xab);
      host.set(bytes, 37);
      const view = host.subarray(37, 37 + bytes.length);
      const before = host.slice();
      const mesh = await loadMesh(view, { fileName: name });
      expect(arraysOf(mesh), name).toEqual({ positions: CUBE_EXPECTED_POSITIONS, faces: CUBE_EXPECTED_FACES });
      expect(host).toEqual(before);
      // Same without a file name: detection must also respect the view.
      expect(arraysOf(await loadMesh(view))).toEqual(arraysOf(mesh));
    }
  });

  it('accepts ArrayBuffers and Node Buffers (pooled, non-zero byteOffset)', async () => {
    const text = objText(CUBE_CORNERS, CUBE_TRIS);
    const nodeBuffer = Buffer.from(text);
    const fromBuffer = await loadMesh(nodeBuffer, { fileName: 'b.obj' });
    const fromArrayBuffer = await loadMesh(utf8(text).slice().buffer, { fileName: 'b.obj' });
    expect(arraysOf(fromBuffer)).toEqual(arraysOf(fromArrayBuffer));
  });
});

describe('loadMesh — options and errors', () => {
  it('options.format overrides detection; sourceName and weldEpsilon are recorded', async () => {
    const mesh = await loadMesh(binaryStl(cubeTriangles()), { format: 'stl', fileName: 'looks-like.obj', weldEpsilon: 0.01 });
    expect(mesh.metadata).toMatchObject({ format: 'stl', sourceName: 'looks-like.obj', weldEpsilon: 0.01 });
    expect(mesh.groups[0].name).toBe('looks-like');
  });

  it('every failure is a MeshLoadError with a useful message', async () => {
    const cases: [Uint8Array, Parameters<typeof loadMesh>[1], RegExp][] = [
      [new Uint8Array(0), { fileName: 'a.stl' }, /a\.stl: empty input/],
      [utf8('just some text'), {}, /unknown mesh format/],
      [utf8(objText(CUBE_CORNERS, CUBE_TRIS)), { format: 'stl' }, /STL/],
      [binaryStl(cubeTriangles()), { format: 'gltf', fileName: 'x.gltf' }, /invalid glTF JSON/],
      [binaryStl(cubeTriangles()), { weldEpsilon: -1 }, /weldEpsilon/],
      [binaryStl(cubeTriangles()), { weldEpsilon: Number.NaN }, /weldEpsilon/],
      [binaryStl(cubeTriangles()), { format: 'fbx' as SourceFormat }, /unsupported format "fbx"/],
    ];
    for (const [bytes, options, message] of cases) {
      const err = await loadMesh(bytes, options).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, String(message)).toBeInstanceOf(MeshLoadError);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).name).toBe('MeshLoadError');
    }
  });

  it('non-MeshLoadError failures inside three.js are wrapped (format + cause kept)', async () => {
    // Accessor pointing past its bufferView: GLTFLoader itself throws.
    const gltf = buildGltf({ meshes: [{ primitives: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] }], nodes: [{ mesh: 0 }] });
    gltf.json.accessors[0].count = 1000;
    const err = (await loadMesh(glbBytes(gltf), { fileName: 'broken.glb' }).catch((e: unknown) => e)) as MeshLoadError;
    expect(err).toBeInstanceOf(MeshLoadError);
    expect(err.format).toBe('glb');
    expect(err.message).toMatch(/^broken\.glb: failed to parse GLB data: /);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('loadMesh — scale', () => {
  it('welds a 1M-triangle binary STL in linear time', async () => {
    const n = 708; // 708² quads × 2 = 1,002,528 triangles, 709² = 502,681 vertices
    const tris = 2 * n * n;
    const bytes = new Uint8Array(84 + 50 * tris);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, tris, true);
    const h = (i: number, j: number): number => Math.sin(i * 0.05) * Math.cos(j * 0.07);
    let o = 84;
    const put = (x: number, y: number, z: number): void => {
      view.setFloat32(o, x, true);
      view.setFloat32(o + 4, y, true);
      view.setFloat32(o + 8, z, true);
      o += 12;
    };
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        o += 12; // normal
        put(i, j, h(i, j));
        put(i + 1, j, h(i + 1, j));
        put(i + 1, j + 1, h(i + 1, j + 1));
        o += 2 + 12;
        put(i, j, h(i, j));
        put(i + 1, j + 1, h(i + 1, j + 1));
        put(i, j + 1, h(i, j + 1));
        o += 2;
      }
    }
    const t0 = performance.now();
    const mesh = await loadMesh(bytes, { fileName: 'terrain.stl' });
    const elapsed = performance.now() - t0;
    expect(mesh.faceCount).toBe(tris);
    expect(mesh.vertexCount).toBe((n + 1) * (n + 1));
    expect(mesh.metadata.sourceVertexCount).toBe(3 * tris);
    // First quad: (0,0), (1,0), (1,1), (0,1) → vertices 0, 1, 2, 3.
    expect(Array.from(mesh.faces.subarray(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
    // Generous bound (typically well under 2 s): guards against accidental O(n²) behaviour.
    expect(elapsed).toBeLessThan(20_000);
  });
});
