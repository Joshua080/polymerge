/**
 * PUBLIC PARSER API: bytes → normalised IMesh (see the NORMALISATION CONTRACT in
 * ../types.ts). Isomorphic (Node ≥ 20 and browsers); parsing is delegated to the stock
 * three.js loaders, welding to ./weld.ts.
 */
import { MeshLoadError, SOURCE_FORMATS, type DetectFormatFn, type LoadMeshFn } from '../types.js';
import { namePrefix, toArrayBuffer, toMeshLoadError } from './bytes.js';
import { detectFormat as detectFormatImpl } from './detect.js';
import { loadGltf } from './gltf.js';
import { loadObj } from './obj.js';
import { loadStl } from './stl.js';

/** Extension first (.stl/.obj/.gltf/.glb, case-insensitive), then content sniffing. Throws MeshLoadError if unknown. */
export const detectFormat: DetectFormatFn = (data, fileName) => detectFormatImpl(data, fileName);

/**
 * Load STL / OBJ / glTF / GLB bytes into a welded IMesh. `data` may be an ArrayBuffer or
 * any Uint8Array view (a non-zero byteOffset is honoured). Throws MeshLoadError for
 * unsupported, corrupt or empty input, including files that yield no triangles.
 */
export const loadMesh: LoadMeshFn = async (data, options = {}) => {
  const { fileName } = options;
  const buffer = toArrayBuffer(data);
  if (buffer.byteLength === 0) throw new MeshLoadError(`${namePrefix(fileName)}empty input`, options.format);
  const weldEpsilon = options.weldEpsilon ?? 0;
  if (typeof weldEpsilon !== 'number' || !Number.isFinite(weldEpsilon) || weldEpsilon < 0) {
    throw new MeshLoadError(`weldEpsilon must be a finite number >= 0 (got ${String(options.weldEpsilon)})`);
  }
  const format = options.format ?? detectFormatImpl(buffer, fileName);
  if (!SOURCE_FORMATS.includes(format)) throw new MeshLoadError(`unsupported format "${String(format)}"`);

  const ctx = { fileName, weldEpsilon };
  try {
    switch (format) {
      case 'stl':
        return loadStl(buffer, ctx);
      case 'obj':
        return loadObj(buffer, ctx);
      case 'gltf':
      case 'glb':
        // Both go through the same path; the container type is sniffed from the bytes.
        return await loadGltf(buffer, ctx);
    }
  } catch (err) {
    throw toMeshLoadError(err, format, fileName);
  }
};

export { formatFromFileName, sniffFormat } from './detect.js';
export { buildWeldedMesh, Uint32TripleMap, type TrianglePart, type WeldInput } from './weld.js';
