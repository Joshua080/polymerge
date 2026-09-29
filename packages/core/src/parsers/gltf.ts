/**
 * glTF (.gltf JSON with embedded data: URIs) and GLB → IMesh via three.js' GLTFLoader.
 *
 * The container is first rewritten into a self-contained GLB (see gltf-container.ts), so
 * GLTFLoader never fetches anything and never decodes an image, in Node or the browser.
 *
 * Scene walk: the default scene (`scene` or scene 0) after `updateMatrixWorld(true)`, in
 * three's traversal order (depth-first, parent before children). Each triangle Mesh
 * becomes one TrianglePart / IMeshGroup with matrixWorld baked in; SkinnedMesh vertices
 * are posed with their skeleton and non-zero default morph weights are applied (both via
 * three's `getVertexPosition`, i.e. what three renders); an InstancedMesh
 * (EXT_mesh_gpu_instancing) contributes every instance to its one group. Points / lines
 * are skipped with a warning.
 *
 * Group names mirror three's naming but use the ORIGINAL glTF names (three sanitises and
 * de-duplicates them): the node name when the three Mesh is the node itself (single
 * primitive), else the glTF mesh name, else the parent node name, else three's
 * `mesh.name` (e.g. "mesh_0"), else the file base name / "default".
 *
 * Materials: keyed by glTF material index (so three's per-mesh clones of one material
 * collapse into one IMaterial), mapped to { name, linear RGBA color (baseColorFactor +
 * opacity), metalness, roughness }. Primitives without a material get -1.
 *
 * Vertex ids: the custom attribute `_VERTEX_ID` (three lowercases it to `_vertex_id`).
 *
 * Appearance (gltf-appearance.ts): the full definition of every IMaterial, the images its texture
 * slots reference (bytes carried as-is, never decoded; external URIs kept as references) and the
 * TEXCOORD_n sets, which the welder turns into per-corner data. Always set, possibly empty.
 */
import type { Material, Mesh, Object3D } from 'three';
import { Group } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { defaultGroupName } from '../mesh.js';
import { defaultMaterialDefinition, pruneImages } from '../appearance.js';
import { MeshLoadError, type IMaterial, type IMaterialDefinition, type IMesh } from '../types.js';
import { namePrefix, toMeshLoadError, type FormatLoadContext } from './bytes.js';
import { captureGltfAppearance, readUvSets, resolveGltfAppearance } from './gltf-appearance.js';
import { prepareGltf, readGltfContainer } from './gltf-container.js';
import { meshToPart } from './three-mesh.js';
import { buildWeldedMesh, type TrianglePart } from './weld.js';

/** three.js attribute name of the glTF `_VERTEX_ID` custom attribute. */
export const VERTEX_ID_ATTRIBUTE = '_vertex_id';

interface MaterialLike {
  name?: string;
  color?: { r: number; g: number; b: number };
  opacity?: number;
  metalness?: number;
  roughness?: number;
  isMeshStandardMaterial?: boolean;
}

function toIMaterial(material: Material, fallbackName: string): IMaterial {
  const m = material as unknown as MaterialLike;
  const out: IMaterial = { name: m.name || fallbackName };
  if (m.color) out.color = [m.color.r, m.color.g, m.color.b, typeof m.opacity === 'number' ? m.opacity : 1];
  if (m.isMeshStandardMaterial) {
    if (typeof m.metalness === 'number') out.metalness = m.metalness;
    if (typeof m.roughness === 'number') out.roughness = m.roughness;
  }
  return out;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).map((n) => `"${n}"`);
  if (names.length > 5) shown.push('…');
  return shown.join(', ');
}

export async function loadGltf(buffer: ArrayBuffer, ctx: FormatLoadContext): Promise<IMesh> {
  const prefix = namePrefix(ctx.fileName);
  const fallbackName = defaultGroupName(ctx.fileName);
  const warnings: string[] = [];
  const container = readGltfContainer(buffer);
  const captured = captureGltfAppearance(container.json);
  const prepared = prepareGltf(container, warnings);
  const { glb, json, format } = prepared;
  const look = resolveGltfAppearance(captured, prepared, warnings);

  let gltf: GLTF;
  try {
    gltf = await new GLTFLoader().parseAsync(glb, '');
  } catch (err) {
    throw toMeshLoadError(err, format, ctx.fileName);
  }
  const parser = gltf.parser;

  let root: Object3D | undefined = gltf.scene;
  const sceneCount = Array.isArray(json.scenes) ? json.scenes.length : 0;
  if (!root) {
    // No scene: fall back to every mesh, untransformed.
    const meshes = (await parser.getDependencies('mesh')) as Object3D[];
    const group = new Group();
    for (const m of meshes) group.add(m);
    root = group;
    if (meshes.length > 0) warnings.push(`glTF defines no scene; its ${meshes.length} mesh(es) were loaded untransformed`);
  } else if (sceneCount > 1) {
    const index = typeof json.scene === 'number' ? json.scene : 0;
    warnings.push(`glTF has ${sceneCount} scenes; only the default scene (#${index}) was loaded`);
  }
  root.updateMatrixWorld(true);

  const materials: IMaterial[] = [];
  const definitions: IMaterialDefinition[] = [];
  const materialByGltfIndex = new Map<number, number>();
  const resolveMaterial = (material: Material | undefined): number => {
    if (!material) return -1;
    const gltfIndex = parser.associations.get(material)?.materials;
    // Unassociated = three's DefaultMaterial for a primitive without `material`.
    if (gltfIndex === undefined) return -1;
    let index = materialByGltfIndex.get(gltfIndex);
    if (index === undefined) {
      index = materials.length;
      materialByGltfIndex.set(gltfIndex, index);
      materials.push(toIMaterial(material, `material_${gltfIndex}`));
      definitions.push(look.materials[gltfIndex] ?? defaultMaterialDefinition());
    }
    return index;
  };

  const nodeName = (obj: Object3D | null): string | undefined => {
    if (!obj) return undefined;
    const n = parser.associations.get(obj)?.nodes;
    return n === undefined ? undefined : json.nodes?.[n]?.name || undefined;
  };
  const groupName = (mesh: Mesh): string => {
    const assoc = parser.associations.get(mesh);
    const meshIndex = assoc?.meshes;
    return (
      nodeName(mesh) ||
      (meshIndex === undefined ? undefined : json.meshes?.[meshIndex]?.name) ||
      nodeName(mesh.parent) ||
      mesh.name ||
      fallbackName
    );
  };

  const parts: TrianglePart[] = [];
  const skipped: string[] = [];
  const skinned: string[] = [];
  const morphed: string[] = [];
  let withIds = 0;
  root.traverse((obj) => {
    if ((obj as Mesh).isMesh) {
      const mesh = obj as Mesh;
      const name = groupName(mesh);
      const info = meshToPart(mesh, { name, resolveMaterial, idAttribute: VERTEX_ID_ATTRIBUTE });
      if (!info) return;
      const uvs = readUvSets(mesh.geometry, mesh.geometry.getAttribute('position').count, info.instances);
      if (uvs) info.part.uvs = uvs;
      parts.push(info.part);
      if (info.skinned) skinned.push(name);
      if (info.morphed) morphed.push(name);
      if (info.part.vertexIds) withIds++;
    } else if ((obj as { isPoints?: boolean }).isPoints || (obj as { isLine?: boolean }).isLine) {
      skipped.push(obj.name || nodeName(obj) || fallbackName);
    }
  });

  if (skipped.length) {
    warnings.push(`skipped ${skipped.length} point/line primitive(s) (${listNames(skipped)}): only triangles are kept`);
  }
  if (skinned.length) {
    warnings.push(`${skinned.length} skinned mesh(es) (${listNames(skinned)}) baked in the pose defined by the file's node transforms`);
  }
  if (morphed.length) {
    warnings.push(`${morphed.length} mesh(es) (${listNames(morphed)}) have non-zero default morph weights; the morphed shape was baked`);
  }
  if (withIds > 0 && withIds < parts.length) {
    warnings.push(`_VERTEX_ID present on ${withIds} of ${parts.length} mesh(es); other vertices have null ids`);
  }
  if (parts.length === 0) {
    throw new MeshLoadError(
      `${prefix}glTF contains no triangle meshes${skipped.length ? ` (${skipped.length} point/line primitive(s) skipped)` : ''}`,
      format,
    );
  }

  const asset = json.asset ?? {};
  const extras: Record<string, unknown> = { version: String(asset.version) };
  if (typeof asset.generator === 'string') extras.generator = asset.generator;
  if (typeof asset.copyright === 'string') extras.copyright = asset.copyright;
  if (json.extensionsUsed?.length) extras.extensionsUsed = [...json.extensionsUsed];
  if (json.extensionsRequired?.length) extras.extensionsRequired = [...json.extensionsRequired];

  const mesh = buildWeldedMesh({
    format,
    parts,
    materials,
    fileName: ctx.fileName,
    weldEpsilon: ctx.weldEpsilon,
    warnings,
    extras,
    appearance: { materials: definitions, images: look.images },
  });
  if (mesh.appearance) mesh.appearance = pruneImages(mesh.appearance);
  return mesh;
}
