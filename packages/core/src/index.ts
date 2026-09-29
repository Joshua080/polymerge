/**
 * polymerge-core public API. Isomorphic: runs in Node ≥ 20 and modern browsers
 * (no fs / DOM access in this package; callers pass bytes in).
 */
export * from './types.js';
export * from './mesh.js';
export { detectFormat, loadMesh } from './parsers/index.js';
export { diffMeshes, serializeDiff, deserializeDiff } from './diff/index.js';
export { mergeMeshes, resolveMerge } from './merge/index.js';
export {
  writeMesh,
  writeObj,
  writeStl,
  writeGlb,
  writeGltf,
  buildGltfDocument,
  formatFloat32,
  WRITABLE_FORMATS,
  type WritableFormat,
  type IGltfDocument,
  type IGltfWriteOptions,
} from './writers/index.js';
export { cloneScene } from './scene.js';
