/**
 * Helpers for `IMesh.scene` (glTF scene structure), shared by the glTF loader, the merge and the
 * glTF writer.
 *
 * Matrices are computed with three.js exactly as GLTFLoader + Object3D compute them when a file
 * is loaded (a `matrix` node is decomposed to T/R/S and recomposed; world = parent world × local).
 * The writer relies on this: it un-bakes positions with the very matrix the loader will bake them
 * with again when the written file is read back, which is what makes glTF → IMesh → glTF → IMesh
 * float32-exact.
 */
import { Matrix4, Object3D } from 'three';
import type { IMeshScene, ISceneNode } from './types.js';

export type SceneTransform = Pick<ISceneNode, 'matrix' | 'translation' | 'rotation' | 'scale'>;

/** Local matrix of a node, as GLTFLoader builds it. */
export function nodeLocalMatrix(node: SceneTransform): Matrix4 {
  const o = new Object3D();
  if (node.matrix) {
    o.applyMatrix4(new Matrix4().fromArray(node.matrix));
  } else {
    if (node.translation) o.position.fromArray(node.translation);
    if (node.rotation) o.quaternion.fromArray(node.rotation);
    if (node.scale) o.scale.fromArray(node.scale);
  }
  o.updateMatrix();
  return o.matrix;
}

/**
 * World matrix of every node reachable from `roots` (others stay undefined), as three.js'
 * `updateMatrixWorld` computes it under the loader's identity scene group. `local` overrides a
 * node's own transform (the merge uses it to try candidate transforms).
 */
export function worldMatrices(
  nodes: readonly (SceneTransform & { children: readonly number[] })[],
  roots: readonly number[],
  local: (n: number) => Matrix4 = (n) => nodeLocalMatrix(nodes[n]),
): (Matrix4 | undefined)[] {
  const worlds: (Matrix4 | undefined)[] = new Array(nodes.length);
  const scene = new Matrix4();
  const visit = (n: number, parent: Matrix4): void => {
    if (worlds[n] || n < 0 || n >= nodes.length) return; // guards against malformed (cyclic) hierarchies
    const w = new Matrix4().multiplyMatrices(parent, local(n));
    worlds[n] = w;
    for (const c of nodes[n].children) visit(c, w);
  };
  for (const r of roots) visit(r, scene);
  return worlds;
}

/** Same local transform, written the same way (exact numbers). */
export function sameTransform(a: SceneTransform, b: SceneTransform): boolean {
  const eq = (x?: readonly number[], y?: readonly number[]): boolean =>
    x === y || (!!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]));
  return eq(a.matrix, b.matrix) && eq(a.translation, b.translation) && eq(a.rotation, b.rotation) && eq(a.scale, b.scale);
}

/** Copy of a node's local transform fields (only those present). */
export function copyTransform(node: SceneTransform): SceneTransform {
  const out: SceneTransform = {};
  if (node.matrix) out.matrix = [...node.matrix];
  if (node.translation) out.translation = [...node.translation];
  if (node.rotation) out.rotation = [...node.rotation];
  if (node.scale) out.scale = [...node.scale];
  return out;
}

/** Deep copy of a scene (typed arrays included). */
export function cloneScene(scene: IMeshScene): IMeshScene {
  const out: IMeshScene = {
    nodes: scene.nodes.map((n) => {
      const c: ISceneNode = { ...copyTransform(n), children: [...n.children], world: [...n.world] };
      if (n.name !== undefined) c.name = n.name;
      if (n.mesh !== undefined) c.mesh = n.mesh;
      if (n.baked) c.baked = [...n.baked];
      return c;
    }),
    roots: [...scene.roots],
    meshes: scene.meshes.map((m) => ({ ...m })),
    sources: scene.sources.map((s) => ({ ...s })),
    faceSources: Int32Array.from(scene.faceSources),
  };
  if (scene.name !== undefined) out.name = scene.name;
  return out;
}
