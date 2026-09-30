/**
 * glTF SCENE CAPTURE — records the loaded scene's structure as `IMesh.scene` (types.ts): the nodes
 * (name, children, local transform as written, the world matrix three.js baked with), the meshes,
 * and for every face the node + primitive it came from. Positions are not touched. The glTF writer
 * (writers/gltf.ts) uses this to rebuild the hierarchy and un-bake each node's geometry.
 *
 * Only the loaded (default) scene is recorded: its nodes, in file order, re-indexed densely.
 *
 * three.js objects are mapped back to glTF indices through `GLTFParser.associations`: a node's
 * object carries `nodes`; a primitive's Mesh carries `meshes` + `primitives`. A single-primitive
 * node's Mesh IS the node object; the Meshes of a multi-primitive mesh are its children.
 * EXT_mesh_gpu_instancing replaces those with InstancedMeshes that carry no association; their
 * primitive index is their position among the mesh's children.
 */
import type { Mesh, Object3D } from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { worldMatrices } from '../scene.js';
import type { IMesh, IMeshScene, ISceneMesh, ISceneNode, ISceneSource, Mat4 } from '../types.js';
import type { GltfJson } from './gltf-container.js';
import type { MeshPartInfo } from './three-mesh.js';

interface GltfNodeJson {
  name?: unknown;
  children?: unknown;
  matrix?: unknown;
  translation?: unknown;
  rotation?: unknown;
  scale?: unknown;
  mesh?: unknown;
}

/** A finite number array of length `n`, copied; undefined otherwise. */
function numbers(v: unknown, n: number): number[] | undefined {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [...v] : undefined;
}

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export class SceneCapture {
  private readonly nodes: ISceneNode[] = [];
  private readonly meshes: ISceneMesh[] = [];
  private readonly roots: number[] = [];
  private readonly name: string | undefined;
  /** glTF node index → index into `nodes`. */
  private readonly nodeIndex = new Map<number, number>();

  constructor(
    json: GltfJson,
    private readonly parser: GLTFParser,
    root: Object3D,
    sceneIndex: number,
  ) {
    const fileNodes = (Array.isArray(json.nodes) ? json.nodes : []) as GltfNodeJson[];
    const sceneDef = (Array.isArray(json.scenes) ? json.scenes[sceneIndex] : undefined) as { name?: unknown; nodes?: unknown } | undefined;
    if (typeof sceneDef?.name === 'string' && sceneDef.name) this.name = sceneDef.name;
    const rootList = Array.isArray(sceneDef?.nodes) ? sceneDef.nodes.filter((n) => isIndex(n) && n < fileNodes.length) : [];

    // Nodes reachable from the scene roots, kept in file order.
    const reached = new Set<number>();
    const reach = (n: number): void => {
      if (reached.has(n)) return;
      reached.add(n);
      const children = fileNodes[n]?.children;
      if (Array.isArray(children)) for (const c of children) if (isIndex(c) && c < fileNodes.length) reach(c);
    };
    for (const r of rootList) reach(r);
    const order = [...reached].sort((a, b) => a - b);
    order.forEach((n, i) => this.nodeIndex.set(n, i));

    // Meshes those nodes reference, in file order.
    const fileMeshes = Array.isArray(json.meshes) ? json.meshes : [];
    const meshIndex = new Map<number, number>();
    const usedMeshes = order.map((n) => fileNodes[n].mesh).filter((m): m is number => isIndex(m) && m < fileMeshes.length);
    for (const m of [...new Set(usedMeshes)].sort((a, b) => a - b)) {
      meshIndex.set(m, this.meshes.length);
      const name = fileMeshes[m]?.name;
      this.meshes.push(typeof name === 'string' && name ? { name } : {});
    }

    // The world matrix three.js baked with, per node object.
    const objectOf = new Map<number, Object3D>();
    root.traverse((obj) => {
      const n = parser.associations.get(obj)?.nodes;
      if (n !== undefined && !objectOf.has(n)) objectOf.set(n, obj);
    });

    for (const n of order) {
      const def = fileNodes[n];
      const node: ISceneNode = { children: [], world: [] };
      if (typeof def.name === 'string' && def.name) node.name = def.name;
      if (Array.isArray(def.children)) {
        for (const c of def.children) if (isIndex(c) && this.nodeIndex.has(c)) node.children.push(this.nodeIndex.get(c)!);
      }
      const matrix = numbers(def.matrix, 16);
      if (matrix) node.matrix = matrix;
      else {
        const t = numbers(def.translation, 3);
        const r = numbers(def.rotation, 4);
        const s = numbers(def.scale, 3);
        if (t) node.translation = t as ISceneNode['translation'];
        if (r) node.rotation = r as ISceneNode['rotation'];
        if (s) node.scale = s as ISceneNode['scale'];
      }
      if (isIndex(def.mesh) && meshIndex.has(def.mesh)) node.mesh = meshIndex.get(def.mesh);
      this.nodes.push(node);
    }
    this.roots = rootList.map((r) => this.nodeIndex.get(r)!);

    // Worlds: three's own matrixWorld; recomputed the same way for a node without an object.
    const computed = worldMatrices(this.nodes, this.roots);
    order.forEach((n, i) => {
      const obj = objectOf.get(n);
      const w = obj ? obj.matrixWorld : computed[i];
      this.nodes[i].world = w ? (Array.from(w.elements) as Mat4) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    });
  }

  /** The node + primitive a loaded three.js Mesh came from (null if it is not under a scene node). */
  sourceOf(mesh: Mesh, info: MeshPartInfo): ISceneSource | null {
    const assoc = this.parser.associations;
    let obj: Object3D | null = mesh;
    let fileNode: number | undefined;
    while (obj) {
      fileNode = assoc.get(obj)?.nodes;
      if (fileNode !== undefined) break;
      obj = obj.parent;
    }
    const node = fileNode === undefined ? undefined : this.nodeIndex.get(fileNode);
    if (node === undefined) return null;
    const primitive = assoc.get(mesh)?.primitives ?? (obj === mesh || !mesh.parent ? 0 : mesh.parent.children.indexOf(mesh));
    const baked: ('skin' | 'morph' | 'instances')[] = [];
    if (info.skinned) baked.push('skin');
    if (info.morphed) baked.push('morph');
    if (info.instances > 1) baked.push('instances');
    if (baked.length) {
      const n = this.nodes[node];
      n.baked = [...new Set([...(n.baked ?? []), ...baked])];
    }
    return { node, primitive: Math.max(0, primitive) };
  }

  /**
   * Attach the structure to the welded mesh. `partSources[p]` is the source of TrianglePart p;
   * `groupParts[g]` the part that produced group g (see WeldInput.groupParts).
   */
  attach(mesh: IMesh, partSources: readonly (ISceneSource | null)[], groupParts: readonly number[]): void {
    const sources: ISceneSource[] = [];
    const byKey = new Map<string, number>();
    const faceSources = new Int32Array(mesh.faceCount).fill(-1);
    mesh.groups.forEach((g, gi) => {
      const s = partSources[groupParts[gi]];
      if (!s) return;
      const key = `${s.node}:${s.primitive}`;
      let i = byKey.get(key);
      if (i === undefined) {
        i = sources.length;
        byKey.set(key, i);
        sources.push(s);
      }
      faceSources.fill(i, g.faceStart, g.faceStart + g.faceCount);
    });
    const scene: IMeshScene = { nodes: this.nodes, roots: this.roots, meshes: this.meshes, sources, faceSources };
    if (this.name !== undefined) scene.name = this.name;
    mesh.scene = scene;
  }
}
