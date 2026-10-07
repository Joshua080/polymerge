/**
 * polymerge-core public API. Isomorphic: runs in Node ≥ 20 and modern browsers
 * (no fs / DOM access in this package; callers pass bytes in).
 */
export * from './types.js';
export * from './mesh.js';
export { compareMetrics, computeMetrics, displayUnit, formatChange, formatMeasure, formatNumber, formatUnit, volumeNote } from './metrics.js';
export { detectFormat, formatFromFileName, loadMesh, STEP_ANGULAR_DEFLECTION, STEP_DEFLECTION_RATIO, stepDeflectionFor, stepInfo } from './parsers/index.js';
export { diffMeshes, serializeDiff, deserializeDiff } from './diff/index.js';
export { changeRegions, type IChangeRegion } from './diff/regions.js';
export { sectionMesh, type ISection, type ISectionLoop, type SectionAxis } from './section.js';
export { SurfaceLocator, type ISurfacePoint } from './locate.js';
export { describeSurface, describeVector } from './brep.js';
export { mergeMeshes, resolveMerge } from './merge/index.js';
export {
  defaultMaterialDefinition,
  hashBytes,
  materialSummary,
  TEXTURE_SLOTS,
  textureRefsOf,
  textureRefUvSet,
  type TextureSlot,
} from './appearance.js';
export {
  writeMesh,
  writeObj,
  writeStl,
  writeGlb,
  writeGltf,
  writePly,
  writeThreeMf,
  buildGltfDocument,
  formatFloat32,
  WRITABLE_FORMATS,
  type WritableFormat,
  type IGltfDocument,
  type IGltfWriteOptions,
} from './writers/index.js';
export { cloneScene } from './scene.js';
