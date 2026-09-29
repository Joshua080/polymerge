/**
 * glTF appearance loading (docs/appearance-merge-design.md §2): per-corner UVs through welding,
 * material definitions with texture slots, images carried as bytes or references (never decoded),
 * content identity of images, and that STL / OBJ carry no appearance.
 */
import { describe, expect, it } from 'vitest';
import { hashBytes } from '../../src/appearance.js';
import { loadMesh } from '../../src/parsers/index.js';
import type { IMesh } from '../../src/types.js';
import { asciiStl, buildGltf, CUBE_CORNERS, CUBE_TRIS, cubeTriangles, glbBytes, gltfText, objText, utf8, type BuiltGltf, type PrimitiveSpec } from './helpers.js';

const FLOAT = 5126;
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG.slice(PNG.indexOf(',') + 1)), (c) => c.charCodeAt(0));

/** Append image bytes to the BIN buffer as a bufferView-backed image; returns the image index. */
function embedImage(g: BuiltGltf, bytes: Uint8Array, mimeType: string): number {
  const offset = (g.bin.length + 3) & ~3;
  const bin = new Uint8Array(offset + bytes.length);
  bin.set(g.bin);
  bin.set(bytes, offset);
  g.bin = bin;
  g.json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
  g.json.buffers[0].byteLength = bin.length;
  g.json.images = [...(g.json.images ?? []), { bufferView: g.json.bufferViews.length - 1, mimeType }];
  return g.json.images.length - 1;
}

async function loadBoth(g: BuiltGltf): Promise<[IMesh, IMesh]> {
  return [await loadMesh(glbBytes(g), { fileName: 'm.glb' }), await loadMesh(utf8(gltfText(g)), { fileName: 'm.gltf' })];
}

/** A unit quad as two triangles with a UV seam along its diagonal (non-indexed: 6 corners). */
const seamQuad = (): PrimitiveSpec => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0],
  attributes: { TEXCOORD_0: { data: [0, 0, 0.5, 0, 0.5, 0.5, 0.6, 0.1, 1, 0.6, 0.6, 0.6], type: 'VEC2', componentType: FLOAT } },
});

describe('glTF appearance — per-corner UVs', () => {
  it('UVs belong to face corners: a seam keeps different UVs at one welded vertex', async () => {
    const [mesh, text] = await loadBoth(buildGltf({ meshes: [{ primitives: [seamQuad()] }], nodes: [{ mesh: 0 }] }));
    expect(mesh.vertexCount).toBe(4); // welded by position only
    expect(mesh.faceCount).toBe(2);
    expect(Array.from(mesh.appearance!.uvs[0])).toEqual([0, 0, 0.5, 0, 0.5, 0.5, 0.6000000238418579, 0.10000000149011612, 1, 0.6000000238418579, 0.6000000238418579, 0.6000000238418579]);
    // Vertex 0 (the origin) is corner 0 of both faces, with different UVs.
    expect(mesh.faces[0]).toBe(mesh.faces[3]);
    expect(mesh.appearance!.uvs[0][0]).not.toBe(mesh.appearance!.uvs[0][6]);
    expect(Array.from(text.appearance!.uvs[0])).toEqual(Array.from(mesh.appearance!.uvs[0]));
  });

  it('dropped degenerate triangles drop their corners too: UVs stay in sync with faces', async () => {
    const prim: PrimitiveSpec = {
      positions: CUBE_CORNERS.flat(),
      indices: [0, 2, 1, 3, 3, 3, 0, 3, 2], // the middle triangle is degenerate
      attributes: { TEXCOORD_0: { data: CUBE_CORNERS.flatMap((c, i) => [i / 10, c[2]]), type: 'VEC2', componentType: FLOAT } },
    };
    const [mesh] = await loadBoth(buildGltf({ meshes: [{ primitives: [prim] }], nodes: [{ mesh: 0 }] }));
    expect(mesh.faceCount).toBe(2);
    expect(mesh.metadata.degenerateFacesDropped).toBe(1);
    const uv = Array.from(mesh.appearance!.uvs[0], (x) => Number(x.toFixed(4)));
    expect(uv).toEqual([0, 0, 0.2, 0, 0.1, 0, 0, 0, 0.3, 0, 0.2, 0]); // corners of (0, 2, 1) then (0, 3, 2)
  });

  it('TEXCOORD_1 is the second set; primitives without a set get NaN for their faces', async () => {
    const tri = (z: number, extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({ positions: [0, 0, z, 1, 0, z, 0, 1, z], ...extra });
    const uv = (s: number) => ({ data: [0, 0, s, 0, 0, s], type: 'VEC2' as const, componentType: FLOAT });
    const g = buildGltf({
      meshes: [{ primitives: [tri(0, { attributes: { TEXCOORD_0: uv(1), TEXCOORD_1: uv(0.5) } }), tri(1, { attributes: { TEXCOORD_0: uv(0.25) } }), tri(2)] }],
      nodes: [{ mesh: 0 }],
    });
    const [mesh] = await loadBoth(g);
    const [set0, set1] = mesh.appearance!.uvs;
    expect(mesh.appearance!.uvs).toHaveLength(2);
    expect(Array.from(set0.subarray(0, 12))).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 0.25, 0, 0, 0.25]);
    expect(Array.from(set1.subarray(0, 6))).toEqual([0, 0, 0.5, 0, 0, 0.5]);
    expect(Array.from(set1.subarray(6), (x) => Number.isNaN(x))).toEqual(new Array(12).fill(true));
    expect(Array.from(set0.subarray(12), (x) => Number.isNaN(x))).toEqual(new Array(6).fill(true));
  });

  it('normalised integer UVs (KHR_mesh_quantization) are de-normalised as three.js reads them', async () => {
    const g = buildGltf({
      meshes: [{ primitives: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], attributes: { TEXCOORD_0: { data: [0, 0, 65535, 0, 0, 32768], type: 'VEC2', componentType: 5123 } } }] }],
      nodes: [{ mesh: 0 }],
      extra: { extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'] },
    });
    g.json.accessors[g.json.meshes[0].primitives[0].attributes.TEXCOORD_0].normalized = true;
    const [mesh] = await loadBoth(g);
    const uv = Array.from(mesh.appearance!.uvs[0]);
    expect(uv.slice(0, 5)).toEqual([0, 0, 1, 0, 0]);
    expect(uv[5]).toBeCloseTo(32768 / 65535, 6);
  });
});

describe('glTF appearance — materials and texture references', () => {
  const material = {
    name: 'Painted',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 0.5, 0.25, 1],
      metallicFactor: 0.2,
      baseColorTexture: { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { offset: [0.5, 0], scale: [2, 2] } } },
      metallicRoughnessTexture: { index: 1 },
    },
    normalTexture: { index: 1, scale: 0.5 },
    occlusionTexture: { index: 1, strength: 1 },
    emissiveFactor: [0.1, 0, 0],
    alphaMode: 'MASK',
    alphaCutoff: 0.3,
    doubleSided: true,
    extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 0 } } },
    extras: { studio: 'A' },
  };

  it('definitions: every core property (defaults filled in), texture slots resolved, extensions and extras kept whole', async () => {
    const g = buildGltf({
      meshes: [{ primitives: [{ ...seamQuad(), material: 0 }] }],
      nodes: [{ mesh: 0 }],
      materials: [material],
      extra: {
        images: [{ uri: 'textures/albedo.png', name: 'albedo' }, { uri: PNG }, { uri: 'unused.png' }],
        textures: [{ source: 0, sampler: 0 }, { source: 1 }, { source: 2 }],
        samplers: [{ magFilter: 9729, wrapS: 33648 }],
        extensionsUsed: ['KHR_materials_clearcoat', 'KHR_texture_transform'],
      },
    });
    const [mesh, text] = await loadBoth(g);
    // The summary is what it always was.
    expect(mesh.materials[0]).toEqual({ name: 'Painted', color: [1, 0.5, 0.25, 1], metalness: 0.2, roughness: 1 });
    expect(mesh.appearance!.materials).toEqual([
      {
        name: 'Painted',
        baseColorFactor: [1, 0.5, 0.25, 1],
        metallicFactor: 0.2,
        roughnessFactor: 1,
        emissiveFactor: [0.1, 0, 0],
        alphaMode: 'MASK',
        alphaCutoff: 0.3,
        doubleSided: true,
        baseColorTexture: { image: 0, texCoord: 1, sampler: { magFilter: 9729, wrapS: 33648 }, transform: { offset: [0.5, 0], scale: [2, 2] } },
        metallicRoughnessTexture: { image: 1, texCoord: 0 },
        normalTexture: { image: 1, texCoord: 0, scale: 0.5 },
        occlusionTexture: { image: 1, texCoord: 0 },
        extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { image: 0, texCoord: 0, sampler: { magFilter: 9729, wrapS: 33648 } } } },
        extras: { studio: 'A' },
      },
    ]);
    // Images: the external one kept as a reference, the data: URI one as bytes; the unused one dropped.
    const images = mesh.appearance!.images;
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({ hash: 'uri:textures/albedo.png', uri: 'textures/albedo.png', name: 'albedo' });
    expect(images[1]).toMatchObject({ hash: hashBytes(PNG_BYTES), mimeType: 'image/png' });
    expect(Array.from(images[1].data!)).toEqual(Array.from(PNG_BYTES));
    expect(text.appearance).toEqual(mesh.appearance);
  });

  it('image identity is the content: a bufferView image (GLB) and the same bytes as a data: URI hash alike', async () => {
    const withBufferView = buildGltf({
      meshes: [{ primitives: [{ ...seamQuad(), material: 0 }] }],
      nodes: [{ mesh: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      extra: { textures: [{ source: 0 }] },
    });
    embedImage(withBufferView, PNG_BYTES, 'image/png');
    const withDataUri = buildGltf({
      meshes: [{ primitives: [{ ...seamQuad(), material: 0 }] }],
      nodes: [{ mesh: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      extra: { textures: [{ source: 0 }], images: [{ uri: PNG, name: 'renamed' }] },
    });
    const [glb, gltf] = await loadBoth(withBufferView);
    const other = await loadMesh(utf8(gltfText(withDataUri)), { fileName: 'other.gltf' });
    expect(glb.appearance!.images[0]).toEqual({ hash: hashBytes(PNG_BYTES), data: PNG_BYTES, mimeType: 'image/png' });
    expect(gltf.appearance!.images[0].hash).toBe(glb.appearance!.images[0].hash);
    expect(other.appearance!.images[0].hash).toBe(glb.appearance!.images[0].hash);
    expect(hashBytes(Uint8Array.of(1, 2, 3))).not.toBe(hashBytes(Uint8Array.of(1, 2, 4)));
  });

  it('unresolvable texture references drop that slot with one warning; materials without textures stay plain', async () => {
    const g = buildGltf({
      meshes: [{ primitives: [{ ...seamQuad(), material: 0 }] }],
      nodes: [{ mesh: 0 }],
      materials: [{ name: 'Broken', pbrMetallicRoughness: { baseColorTexture: { index: 7 } }, normalTexture: { index: 0 } }],
      extra: { textures: [{ source: 3 }] },
    });
    const [mesh] = await loadBoth(g);
    expect(mesh.appearance!.materials[0].baseColorTexture).toBeUndefined();
    expect(mesh.appearance!.materials[0].normalTexture).toBeUndefined();
    expect(mesh.metadata.warnings.join('\n')).toMatch(/2 texture reference problem\(s\) ignored: material 0\.baseColorTexture: texture 7 does not exist/);
  });

  it('unlit and unnamed materials: the extension is a property; the summary keeps the loader name', async () => {
    const g = buildGltf({
      meshes: [{ primitives: [{ ...seamQuad(), material: 0 }, { positions: [0, 0, 5, 1, 0, 5, 0, 1, 5], material: 1 }] }],
      nodes: [{ mesh: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }, { name: 'Flat', extensions: { KHR_materials_unlit: {} } }],
      extra: { extensionsUsed: ['KHR_materials_unlit'] },
    });
    const [mesh] = await loadBoth(g);
    expect(mesh.materials).toEqual([
      { name: 'material_0', color: [0.5, 0.5, 0.5, 1], metalness: 1, roughness: 1 },
      { name: 'Flat', color: [1, 1, 1, 1] },
    ]);
    expect(mesh.appearance!.materials[0].name).toBeUndefined();
    expect(mesh.appearance!.materials[1].extensions).toEqual({ KHR_materials_unlit: {} });
  });
});

describe('glTF appearance — presence', () => {
  it('glTF always carries an appearance layer (possibly empty); STL and OBJ never do', async () => {
    const [mesh] = await loadBoth(buildGltf({ meshes: [{ primitives: [{ positions: CUBE_CORNERS.flat(), indices: CUBE_TRIS.flat() }] }], nodes: [{ mesh: 0 }] }));
    expect(mesh.appearance).toEqual({ materials: [], images: [], uvs: [] });
    const stl = await loadMesh(utf8(asciiStl([{ tris: cubeTriangles() }])), { fileName: 'c.stl' });
    const obj = await loadMesh(utf8(objText(CUBE_CORNERS, CUBE_TRIS)), { fileName: 'c.obj' });
    expect('appearance' in stl).toBe(false);
    expect('appearance' in obj).toBe(false);
  });
});
