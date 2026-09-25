/**
 * @polymerge/core public API. Isomorphic: runs in Node ≥ 20 and modern browsers
 * (no fs / DOM access in this package; callers pass bytes in).
 */
export * from './types.js';
export * from './mesh.js';
export { detectFormat, loadMesh } from './parsers/index.js';
export { diffMeshes, serializeDiff, deserializeDiff } from './diff/index.js';
