/**
 * PUBLIC DIFF API. The exported names and signatures are part of the contract.
 *
 *   diffMeshes(base, target, options)  — tiered vertex-correspondence diff (engine.ts)
 *   serializeDiff / deserializeDiff    — lossless JSON round trip (serialize.ts)
 */
export { diffMeshes } from './engine.js';
export { serializeDiff, deserializeDiff } from './serialize.js';
