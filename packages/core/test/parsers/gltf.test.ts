import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { loadMesh } from '../../src/parsers/index.js';
import { MeshLoadError, type IMesh } from '../../src/types.js';
import {
  arraysOf,
  buildGltf,
  CUBE_CORNERS,
  CUBE_EXPECTED_FACES,
  CUBE_EXPECTED_POSITIONS,
  CUBE_TRIS,
  glbBytes,
  gltfText,
  soupPositions,
  trianglesOf,
  utf8,
  type BuiltGltf,
  type GltfSpec,
  type PrimitiveSpec,
} from './helpers.js';

const cubePrim = (extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({
  positions: CUBE_CORNERS.flat(),
  indices: CUBE_TRIS.flat(),
  ...extra,
});
const triPrim = (z: number, extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({
  positions: [0, 0, z, 1, 0, z, 0, 1, z],
  ...extra,
});

/** Load the same asset as GLB and as .gltf (data URI) and check both agree. */
async function loadBoth(gltf: BuiltGltf, name = 'model'): Promise<IMesh> {
  const glb = await loadMesh(glbBytes(gltf), { fileName: `${name}.glb` });
  const text = await loadMesh(utf8(gltfText(gltf)), { fileName: `${name}.gltf` });
  expect(glb.metadata.format).toBe('glb');
  expect(text.metadata.format).toBe('gltf');
  expect(Array.from(text.positions)).toEqual(Array.from(glb.positions));
  expect(Array.from(text.faces)).toEqual(Array.from(glb.faces));
  expect(text.groups).toEqual(glb.groups);
  expect(text.materials).toEqual(glb.materials);
  expect(text.vertexIds).toEqual(glb.vertexIds);
  return glb;
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, digits = 5): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

describe('glTF / GLB — basics', () => {
  it('indexed cube (GLB and .gltf data URI) → same arrays as the STL cube', async () => {
    const gltf = buildGltf({ meshes: [{ name: 'CubeMesh', primitives: [cubePrim()] }], nodes: [{ mesh: 0 }], generator: 'TestGen 1.0' });
    const mesh = await loadBoth(gltf, 'cube');
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups).toEqual([{ name: 'CubeMesh', faceStart: 0, faceCount: 12 }]);
    expect(mesh.metadata).toMatchObject({
      sourceVertexCount: 8,
      sourceFaceCount: 12,
      degenerateFacesDropped: 0,
      warnings: [],
      extras: { generator: 'TestGen 1.0', version: '2.0' },
    });
    expect('vertexIds' in mesh).toBe(false);
    expect(mesh.materials).toEqual([]);
    expect(mesh.faceMaterials).toBeUndefined();
  });

  it('non-indexed primitive gives the same result', async () => {
    const gltf = buildGltf({
      meshes: [{ primitives: [{ positions: soupPositions(trianglesOf(CUBE_CORNERS, CUBE_TRIS)) }] }],
      nodes: [{ mesh: 0 }],
    });
    const mesh = await loadBoth(gltf);
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.metadata.sourceVertexCount).toBe(36);
  });

  it('degenerate indexed triangles are dropped', async () => {
    const gltf = buildGltf({
      meshes: [{ primitives: [cubePrim({ indices: [0, 0, 1, ...CUBE_TRIS.flat(), 3, 3, 3] })] }],
      nodes: [{ mesh: 0 }],
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.metadata.sourceFaceCount).toBe(14);
    expect(mesh.metadata.degenerateFacesDropped).toBe(2);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
  });

  it('triangle strips and fans are converted by the loader', async () => {
    const gltf = buildGltf({
      meshes: [
        {
          primitives: [
            { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0], mode: 5 }, // strip: 3 triangles
            { positions: [0, 0, 5, 1, 0, 5, 1, 1, 5, 0, 1, 5], mode: 6 }, // fan: 2 triangles
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.faceCount).toBe(5);
    expect(mesh.vertexCount).toBe(9);
  });

  it('KHR_mesh_quantization: integer and normalized, byte-strided POSITION accessors', async () => {
    const ext = { extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'] };
    // Unsigned bytes with a 4-byte stride (spec alignment) → an InterleavedBufferAttribute in three.
    const bytes = buildGltf({
      meshes: [{ primitives: [cubePrim({ positionComponentType: 5121, positionStride: 4 })] }],
      nodes: [{ mesh: 0 }],
      extra: ext,
    });
    const mesh = await loadBoth(bytes);
    expect(arraysOf(mesh)).toEqual({ positions: CUBE_EXPECTED_POSITIONS, faces: CUBE_EXPECTED_FACES });
    // Normalized int16 (32767 → 1.0), de-quantised by a node scale of 2.
    const shorts = buildGltf({
      meshes: [
        {
          primitives: [
            cubePrim({
              positions: CUBE_CORNERS.flat().map((v) => v * 32767),
              positionComponentType: 5122,
              positionStride: 8,
              positionNormalized: true,
            }),
          ],
        },
      ],
      nodes: [{ mesh: 0, scale: [2, 2, 2] }],
      extra: ext,
    });
    const scaled = await loadBoth(shorts);
    expect(arraysOf(scaled)).toEqual({ positions: CUBE_EXPECTED_POSITIONS.map((v) => v * 2), faces: CUBE_EXPECTED_FACES });
  });

  it('GLB whose JSON chunk is padded with NUL bytes, and a GLB passed as an ArrayBuffer', async () => {
    const gltf = buildGltf({ meshes: [{ primitives: [cubePrim()] }], nodes: [{ mesh: 0 }] });
    const bytes = glbBytes(gltf, 0, 0x00);
    const mesh = await loadMesh(bytes.slice().buffer, { fileName: 'nul.glb' });
    expect(mesh.faceCount).toBe(12);
  });
});

describe('glTF — transforms', () => {
  it('bakes nested node TRS and matrix transforms (translation + rotation + scale)', async () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const rot: [number, number, number, number] = [q.x, q.y, q.z, q.w];
    const m = new Matrix4().compose(
      new Vector3(-4, 0.5, 2),
      new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.7),
      new Vector3(1, 3, 0.25),
    );
    const gltf = buildGltf({
      meshes: [{ name: 'Cube', primitives: [cubePrim()] }],
      nodes: [
        { name: 'Parent', translation: [1, 2, 3], rotation: rot, scale: [2, 2, 2], children: [1] },
        { name: 'Child', mesh: 0, translation: [0, 0, 1], scale: [1, 0.5, 1] },
        { name: 'ByMatrix', mesh: 0, matrix: m.elements.slice() },
      ],
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.groups).toEqual([
      { name: 'Child', faceStart: 0, faceCount: 12 },
      { name: 'ByMatrix', faceStart: 12, faceCount: 12 },
    ]);
    expect(mesh.vertexCount).toBe(16);

    const parent = new Matrix4().compose(new Vector3(1, 2, 3), q, new Vector3(2, 2, 2));
    const child = new Matrix4().compose(new Vector3(0, 0, 1), new Quaternion(), new Vector3(1, 0.5, 1));
    const world1 = parent.clone().multiply(child);
    const expected: number[] = [];
    for (const world of [world1, m]) {
      for (let i = 0; i < CUBE_EXPECTED_POSITIONS.length; i += 3) {
        const v = new Vector3().fromArray(CUBE_EXPECTED_POSITIONS, i).applyMatrix4(world);
        expected.push(v.x, v.y, v.z);
      }
    }
    expectClose(mesh.positions, expected);
    // Spot check by hand: corner (1,0,0) → child (1,0,1) → scale 2 (2,0,2) → rot90z (0,2,2) → +T (1,4,5).
    expectClose(mesh.positions.subarray(6, 9), [1, 4, 5]);
    // Winding and topology are unchanged; the second instance only adds new vertices.
    expect(Array.from(mesh.faces.subarray(0, 36))).toEqual(CUBE_EXPECTED_FACES);
    expect(Array.from(mesh.faces.subarray(36))).toEqual(CUBE_EXPECTED_FACES.map((i) => i + 8));
    // Values are float32-exact.
    for (const x of mesh.positions) expect(Math.fround(x)).toBe(x);
  });

  it('only the default scene is loaded; a file without scenes loads its meshes untransformed', async () => {
    const spec: GltfSpec = {
      meshes: [{ primitives: [triPrim(0)] }, { primitives: [triPrim(1)] }],
      nodes: [{ name: 'A', mesh: 0, translation: [10, 0, 0] }, { name: 'B', mesh: 1 }],
      scenes: [[0], [1]],
    };
    const mesh = await loadBoth(buildGltf(spec));
    expect(mesh.groups.map((g) => g.name)).toEqual(['A']);
    expect(mesh.positions[0]).toBe(10);
    expect(mesh.metadata.warnings.join()).toMatch(/2 scenes; only the default scene \(#0\)/);

    const noScene = buildGltf(spec);
    delete noScene.json.scene;
    delete noScene.json.scenes;
    const loose = await loadBoth(noScene);
    expect(loose.faceCount).toBe(2);
    expect(loose.positions[0]).toBe(0);
    expect(loose.metadata.warnings.join()).toMatch(/no scene/);
  });

  it('skinned mesh is posed by its skeleton (as three renders it)', async () => {
    const n = CUBE_CORNERS.length;
    const identity = new Matrix4().elements.slice();
    const gltf = buildGltf({
      meshes: [
        {
          name: 'Skin',
          primitives: [
            cubePrim({
              attributes: {
                JOINTS_0: { data: new Array(n * 4).fill(0), type: 'VEC4', componentType: 5121 },
                WEIGHTS_0: { data: Array.from({ length: n }, () => [1, 0, 0, 0]).flat(), type: 'VEC4', componentType: 5126 },
              },
            }),
          ],
        },
      ],
      nodes: [
        { name: 'Skinned', mesh: 0, skin: 0, translation: [100, 0, 0] },
        { name: 'Joint', translation: [0, 5, 0] },
      ],
      extraAccessors: { ibm: { data: identity, type: 'MAT4', componentType: 5126 } },
      extra: { skins: [{ joints: [1], inverseBindMatrices: '@accessor:ibm' }] },
    });
    const mesh = await loadBoth(gltf);
    expectClose(
      mesh.positions,
      CUBE_EXPECTED_POSITIONS.map((v, i) => (i % 3 === 1 ? v + 5 : v)),
    );
    expect(mesh.metadata.warnings.join()).toMatch(/skinned/);
  });

  it('non-zero default morph weights are baked', async () => {
    const delta = CUBE_CORNERS.flatMap(([, , z]) => [0, 0, z * 2]); // stretch the top face upwards by 2
    const gltf = buildGltf({
      meshes: [{ name: 'M', weights: [0.5], primitives: [cubePrim({ targets: [delta] })] }],
      nodes: [{ mesh: 0 }],
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.metadata.bounds.max[2]).toBe(2);
    expect(mesh.metadata.warnings.join()).toMatch(/morph/);
  });

  it('EXT_mesh_gpu_instancing: every instance lands in the mesh group', async () => {
    const gltf = buildGltf({
      meshes: [{ name: 'Bolt', primitives: [cubePrim({ vertexIds: CUBE_CORNERS.map((_, i) => i) })] }],
      nodes: [{ name: 'Bolts', mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: '@accessor:tr' } } } }],
      extraAccessors: { tr: { data: [0, 0, 0, 10, 0, 0], type: 'VEC3', componentType: 5126 } },
      extra: { extensionsUsed: ['EXT_mesh_gpu_instancing'] },
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.groups).toEqual([{ name: 'Bolts', faceStart: 0, faceCount: 24 }]);
    expect(mesh.vertexCount).toBe(16);
    expect(Array.from(mesh.positions.subarray(24, 27))).toEqual([10, 0, 0]);
    expect(mesh.metadata.bounds.max).toEqual([11, 1, 1]);
    // Ids are suffixed with the instance number so they stay unique.
    expect(mesh.vertexIds!.slice(0, 3)).toEqual(['0#0', '2#0', '1#0']);
    expect(mesh.vertexIds!.slice(8, 11)).toEqual(['0#1', '2#1', '1#1']);
  });
});

describe('glTF — groups, materials, vertex ids', () => {
  it('multi-node / multi-primitive groups are ordered, contiguous and named from the original glTF names', async () => {
    const gltf = buildGltf({
      meshes: [
        { name: 'Wheel', primitives: [triPrim(0, { material: 0 }), triPrim(1, { material: 1 })] },
        { name: 'BodyMesh', primitives: [triPrim(2, { material: 0 })] },
        { primitives: [triPrim(3)] },
        { name: 'Spoke Mesh', primitives: [triPrim(4, { material: 1 })] },
      ],
      nodes: [
        { name: 'Car Root', children: [1, 2, 3, 4] },
        { name: 'Front Wheel', mesh: 0 },
        { name: 'Body', mesh: 1 },
        { mesh: 2 },
        { mesh: 3 },
      ],
      materials: [
        { name: 'Rubber', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.2, 0.3, 0.5], metallicFactor: 0.25, roughnessFactor: 0.75 } },
        { name: 'Chrome', pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0.125 } },
        { name: 'Unused' },
      ],
    });
    const mesh = await loadBoth(gltf, 'car');
    expect(mesh.groups).toEqual([
      { name: 'Wheel', faceStart: 0, faceCount: 1, materialIndex: 0 }, // multi-primitive: glTF mesh name
      { name: 'Wheel', faceStart: 1, faceCount: 1, materialIndex: 1 },
      { name: 'Body', faceStart: 2, faceCount: 1, materialIndex: 0 }, // single primitive: node name
      { name: 'Car Root', faceStart: 3, faceCount: 1 }, // unnamed node + mesh: parent node name
      { name: 'Spoke Mesh', faceStart: 4, faceCount: 1, materialIndex: 1 }, // unnamed node: mesh name (unsanitised)
    ]);
    expect(mesh.materials).toHaveLength(2);
    expect(mesh.materials[0].name).toBe('Rubber');
    expectClose(mesh.materials[0].color!, [0.1, 0.2, 0.3, 0.5], 9);
    expect(mesh.materials[0].metalness).toBe(0.25);
    expect(mesh.materials[0].roughness).toBe(0.75);
    expect(mesh.materials[1]).toEqual({ name: 'Chrome', color: [1, 1, 1, 1], metalness: 1, roughness: 0.125 });
    expect(Array.from(mesh.faceMaterials!)).toEqual([0, 1, 0, -1, 1]);
  });

  it('materials: unnamed → material_<index>, unlit → no PBR fields, one glTF material used with and without vertex colours → one IMaterial', async () => {
    const gltf = buildGltf({
      meshes: [
        {
          primitives: [
            triPrim(0, { material: 0 }),
            triPrim(1, { material: 1 }),
            triPrim(2, {
              material: 0,
              attributes: { COLOR_0: { data: [1, 0, 0, 0, 1, 0, 0, 0, 1], type: 'VEC3', componentType: 5126 } },
            }),
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
      materials: [
        { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } },
        { name: 'Flat', pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] }, extensions: { KHR_materials_unlit: {} } },
      ],
      extra: { extensionsUsed: ['KHR_materials_unlit'] },
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.materials).toEqual([
      { name: 'material_0', color: [0.5, 0.5, 0.5, 1], metalness: 1, roughness: 1 },
      { name: 'Flat', color: [0, 0, 1, 1] },
    ]);
    expect(Array.from(mesh.faceMaterials!)).toEqual([0, 1, 0]);
  });

  it('_VERTEX_ID → vertexIds (first id wins, null where a primitive has none)', async () => {
    const ids = CUBE_CORNERS.map((_, i) => 100 + i);
    const gltf = buildGltf({
      meshes: [
        { name: 'WithIds', primitives: [cubePrim({ vertexIds: ids })] },
        { name: 'NoIds', primitives: [{ positions: [0, 0, 0, 0, 0, 5, 5, 0, 5] }] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 1 }],
    });
    const mesh = await loadBoth(gltf);
    // Cube vertices enter as c0, c2, c1, c3, c4, c5, c6, c7; (0,0,0) is shared with NoIds.
    expect(mesh.vertexIds).toEqual(['100', '102', '101', '103', '104', '105', '106', '107', null, null]);
    expect(mesh.metadata.warnings.join()).toMatch(/_VERTEX_ID present on 1 of 2 mesh/);

    // Id-less primitive first: the shared corner still gets its id from the later primitive.
    const swapped = buildGltf({
      meshes: [
        { name: 'NoIds', primitives: [{ positions: [0, 0, 0, 0, 0, 5, 5, 0, 5] }] },
        { name: 'WithIds', primitives: [cubePrim({ vertexIds: ids })] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 1 }],
    });
    const mesh2 = await loadBoth(swapped);
    expect(mesh2.vertexIds!.slice(0, 3)).toEqual(['100', null, null]);
    expect(mesh2.vertexIds).toHaveLength(mesh2.vertexCount);
  });
});

describe('glTF — resources, extensions, errors', () => {
  it('textures and images are stripped (no fetch / image decoding), with a warning', async () => {
    const png1x1 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const gltf = buildGltf({
      meshes: [{ primitives: [cubePrim({ material: 0 })] }],
      nodes: [{ mesh: 0 }],
      materials: [
        {
          name: 'Painted',
          pbrMetallicRoughness: {
            baseColorFactor: [1, 0, 0, 1],
            baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [2, 2] } } },
          },
          normalTexture: { index: 1, scale: 1 },
          extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 0 } } },
        },
      ],
      extra: {
        images: [{ uri: 'textures/albedo.png' }, { uri: png1x1 }],
        textures: [{ source: 0, sampler: 0 }, { source: 1 }],
        samplers: [{ magFilter: 9729 }],
        extensionsUsed: ['KHR_materials_clearcoat', 'KHR_texture_transform'],
      },
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.faceCount).toBe(12);
    expect(mesh.materials[0]).toMatchObject({ name: 'Painted', color: [1, 0, 0, 1] });
    expect(mesh.metadata.warnings.join()).toMatch(/textures ignored \(2 image\(s\), 2 texture\(s\), 3 material texture reference/);
  });

  it('external buffer URIs → MeshLoadError', async () => {
    const gltf = buildGltf({ meshes: [{ primitives: [cubePrim()] }], nodes: [{ mesh: 0 }] });
    const json = structuredClone(gltf.json);
    json.buffers[0].uri = 'cube.bin';
    await expect(loadMesh(utf8(JSON.stringify(json)), { fileName: 'ext.gltf' })).rejects.toThrow(
      /external resources not supported in v1/,
    );
  });

  it('required Draco / meshopt → MeshLoadError; optional Draco falls back to plain accessors', async () => {
    for (const ext of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression']) {
      const gltf = buildGltf({
        meshes: [{ primitives: [cubePrim()] }],
        nodes: [{ mesh: 0 }],
        extra: { extensionsUsed: [ext], extensionsRequired: [ext] },
      });
      await expect(loadMesh(glbBytes(gltf), { fileName: 'c.glb' })).rejects.toThrow(
        new RegExp(`requires ${ext}; compressed geometry is not supported in v1`),
      );
    }
    const optional = buildGltf({
      meshes: [{ primitives: [cubePrim({ extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } })] }],
      nodes: [{ mesh: 0 }],
      extra: { extensionsUsed: ['KHR_draco_mesh_compression'] },
    });
    const mesh = await loadBoth(optional);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.metadata.warnings.join()).toMatch(/optional KHR_draco_mesh_compression ignored/);
  });

  it('points and lines are skipped with a warning; a file with only points → MeshLoadError', async () => {
    const gltf = buildGltf({
      meshes: [{ name: 'Mixed', primitives: [triPrim(0), triPrim(1, { mode: 0 }), { positions: [0, 0, 0, 1, 1, 1], mode: 1 }] }],
      nodes: [{ mesh: 0 }],
    });
    const mesh = await loadBoth(gltf);
    expect(mesh.faceCount).toBe(1);
    expect(mesh.metadata.warnings.join()).toMatch(/skipped 2 point\/line primitive/);

    const pointsOnly = buildGltf({ meshes: [{ primitives: [triPrim(0, { mode: 0 })] }], nodes: [{ mesh: 0 }] });
    await expect(loadMesh(glbBytes(pointsOnly), { fileName: 'p.glb' })).rejects.toThrow(/no triangle meshes/);
  });

  it('corrupt / unsupported containers → MeshLoadError', async () => {
    const gltf = buildGltf({ meshes: [{ primitives: [cubePrim()] }], nodes: [{ mesh: 0 }] });
    const glb = glbBytes(gltf);
    await expect(loadMesh(glb.subarray(0, glb.length - 20), { fileName: 't.glb' })).rejects.toThrow(/truncated GLB/);
    const v1 = glb.slice();
    new DataView(v1.buffer).setUint32(4, 1, true);
    await expect(loadMesh(v1, { format: 'glb' })).rejects.toThrow(/GLB container version 1/);
    await expect(loadMesh(utf8('{ "asset": '), { fileName: 'bad.gltf' })).rejects.toThrow(/invalid glTF JSON/);
    await expect(loadMesh(utf8('{"asset":{"version":"1.0"}}'), { fileName: 'old.gltf' })).rejects.toThrow(
      /unsupported glTF version "1.0"/,
    );
    await expect(loadMesh(utf8('{"meshes":[]}'), { fileName: 'noasset.gltf' })).rejects.toThrow(/asset\.version/);
    await expect(loadMesh(utf8('{"asset":{"version":"2.0"}}'), { fileName: 'empty.gltf' })).rejects.toThrow(
      /no triangle meshes/,
    );
    const shortBuffer = structuredClone(gltf.json);
    shortBuffer.buffers[0].byteLength += 64;
    await expect(loadMesh(glbBytes({ json: shortBuffer, bin: gltf.bin }), { format: 'glb' })).rejects.toThrow(/truncated/);
    const badBase64 = JSON.parse(gltfText(gltf));
    badBase64.buffers[0].uri = 'data:application/octet-stream;base64,@@@@';
    await expect(loadMesh(utf8(JSON.stringify(badBase64)), { format: 'gltf' })).rejects.toThrow(/base64/);
    // Every failure is a MeshLoadError.
    await expect(loadMesh(utf8('{ "asset": '), { format: 'gltf' })).rejects.toBeInstanceOf(MeshLoadError);
  });

  it('percent-encoded (non-base64) data URIs are decoded too', async () => {
    const gltf = buildGltf({ meshes: [{ primitives: [cubePrim()] }], nodes: [{ mesh: 0 }] });
    const json = structuredClone(gltf.json);
    json.buffers[0].uri = 'data:application/octet-stream,' + Array.from(gltf.bin, (b) => `%${b.toString(16).padStart(2, '0')}`).join('');
    const mesh = await loadMesh(utf8(JSON.stringify(json)), { format: 'gltf' });
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
  });
});
