/**
 * Three.js scene for one diff: target mesh coloured per face status, removed base faces,
 * a translucent base ghost, vertex markers, displacement vectors, a wireframe overlay and a
 * selection highlight. World space == diff TARGET space.
 *
 * Merge review (showMerge) reuses the same stage: the merged mesh coloured by who shaped each
 * face, an outline of the selected conflict region and ghost previews of its versions.
 * World space == the MERGED frame.
 *
 * "Model space" below is that target (or merged) space. Scene world space equals it when Y is up;
 * with Z up (CAD, 3D printing) the content is turned −90° about X around the model's centre, so
 * every point or box coming in or going out is converted (toWorld / toModel).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FaceStatus, type FaceStatusCode, type IDiffResult, type IMesh, type Vec3 } from 'polymerge-core';
import { diffColors, type UpAxis } from '../view-options.js';
import { onThemeChange, sceneTheme } from '../theme.js';
import {
  alignPositions,
  boxOf,
  buildDisplacementVectors,
  buildFaceLayer,
  buildIndexedGeometry,
  buildMarkers,
  isIdentityMatrix,
  makeDotTexture,
  makeRingTexture,
  type IFaceLayer,
} from './layers.js';
import { buildFaceSubset, buildMergeLayer, type IGhostSpec, type IMergeLayer, type MergeFaceKind } from './merge-layers.js';

export interface ILayerVisibility {
  /** Target mesh, coloured by face status. */
  target: boolean;
  /** Base faces with status Removed (red), in target space. */
  removed: boolean;
  /** Whole base mesh, translucent, in target space. */
  ghost: boolean;
  /** Include Unchanged target faces. */
  unchanged: boolean;
  /** Points on Moved / Added / Removed vertices. */
  markers: boolean;
  /** Aligned-base → target lines for Moved vertices. */
  vectors: boolean;
  /** Edge overlay on target (and removed) faces. */
  wireframe: boolean;
}

export const DEFAULT_LAYERS: ILayerVisibility = {
  target: true,
  removed: true,
  ghost: false,
  unchanged: true,
  markers: true,
  vectors: true,
  wireframe: false,
};

export interface IPickHit {
  /** Which mesh `vertex` / `face` index into. */
  side: 'base' | 'target' | 'merged';
  vertex: number;
  face: number;
  /** Status of the picked face (null in single-mesh preview / merge review). */
  faceStatus: number | null;
  /** 'base' / 'target': one side of a diff on its own (the before / after capture). */
  layer: 'target' | 'removed' | 'ghost' | 'preview' | 'merged' | 'base';
  /** Hit point, target (or merged) space. */
  point: Vec3;
}

/** Merge review layers. */
export interface IMergeLayerVisibility {
  /** Faces neither side changed (grey). */
  unchanged: boolean;
  wireframe: boolean;
  /** The whole base model, translucent. */
  baseGhost: boolean;
  /** Ghosts of the selected conflict region as base / ours / theirs have it. */
  previewBase: boolean;
  previewOurs: boolean;
  previewTheirs: boolean;
}

export const DEFAULT_MERGE_LAYERS: IMergeLayerVisibility = {
  unchanged: true,
  wireframe: false,
  baseGhost: false,
  previewBase: false,
  previewOurs: true,
  previewTheirs: true,
};

export interface ILayerCounts {
  targetFaces: number;
  changedTargetFaces: number;
  removedFaces: number;
  markers: number;
  vectors: number;
}

interface IPickable {
  object: THREE.Mesh;
  layer: IPickHit['layer'];
  side: IPickHit['side'];
  mesh: IMesh;
  /** Positions of `mesh` in target space. */
  positions: Float64Array;
  /** Draw triangle → mesh face (null = identity, for indexed geometry). */
  faceMap: Uint32Array | null;
  status: Uint8Array | null;
}

/** Default view direction, from the look-at point towards the camera: a 3/4 view from above. */
export const DEFAULT_VIEW: Vec3 = [0.9, 0.62, 1.25];

/**
 * DEFAULT_VIEW in model space for an up axis: the same 3/4 view from above on screen. With Z up
 * that is from the front (−Y), the right and above, like a CAD tool's default view.
 */
export function defaultView(up: UpAxis): Vec3 {
  return up === 'z' ? [DEFAULT_VIEW[0], -DEFAULT_VIEW[2], DEFAULT_VIEW[1]] : [...DEFAULT_VIEW];
}

export class DiffViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  readonly controls: OrbitControls;
  onPick: ((hit: IPickHit | null) => void) | null = null;

  private readonly container: HTMLElement;
  private readonly content = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private layers: ILayerVisibility = { ...DEFAULT_LAYERS };
  private objects: {
    target?: THREE.Mesh;
    targetWire?: THREE.Mesh;
    targetLayer?: IFaceLayer;
    removed?: THREE.Mesh;
    removedWire?: THREE.Mesh;
    ghost?: THREE.Mesh;
    ghostWire?: THREE.Mesh;
    markers?: THREE.Points;
    vectors?: THREE.LineSegments;
  } = {};
  private merge: {
    layer?: IMergeLayer;
    mesh?: THREE.Mesh;
    wire?: THREE.Mesh;
    baseGhost?: THREE.Mesh;
    highlight?: THREE.Mesh;
    ghosts: { label: IGhostSpec['label']; objects: THREE.Mesh[] }[];
  } = { ghosts: [] };
  private mergeLayers: IMergeLayerVisibility = { ...DEFAULT_MERGE_LAYERS };
  /** The version whose ghost is shown filled (hovering its resolution button), if any. */
  private ghostEmphasis: IGhostSpec['label'] | null = null;
  private pickables: IPickable[] = [];
  private previewMode = false;
  private origin = new THREE.Vector3();
  private sceneRadius = 1;
  private home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private up: UpAxis = 'y';
  /** The last framing (model space; a null direction = the up axis's default view). */
  private lastFit: { box: THREE.Box3; direction: Vec3 | null } | null = null;
  /** Redraws the current content (the last show* call), to repaint it in a new palette. */
  private replay: (() => void) | null = null;
  /** While set, framing updates "home" but leaves the camera where the user put it. */
  private holdCamera = false;
  private selectionState: { from: Vec3 | null; to: Vec3 | null } | null = null;
  private dirty = true;
  private raf = 0;
  private renderWaiters: (() => void)[] = [];
  private pointerDown: { x: number; y: number; id: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly stopThemeWatch: () => void;

  private readonly materials = {
    target: new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
      // Pushed back so the wireframe, markers and removed-vs-target overlays never z-fight.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    removed: new THREE.MeshLambertMaterial({
      color: diffColors().removed,
      flatShading: true,
      side: THREE.DoubleSide,
      // Behind coincident target faces: "what is there now" wins, red shows what is gone.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
    ghost: new THREE.MeshLambertMaterial({
      color: sceneTheme().baseAccent,
      flatShading: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: sceneTheme().ghostOpacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 3,
      polygonOffsetUnits: 3,
    }),
    ghostWire: new THREE.MeshBasicMaterial({
      color: sceneTheme().baseAccent,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
    wire: new THREE.MeshBasicMaterial({
      color: sceneTheme().wire,
      wireframe: true,
      transparent: true,
      opacity: sceneTheme().wireOpacity,
      depthWrite: false,
    }),
    markers: withDepthBias(
      new THREE.PointsMaterial({
        size: 7,
        sizeAttenuation: false,
        vertexColors: true,
        map: makeDotTexture(),
        alphaTest: 0.5,
      }),
    ),
    vectors: new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    }),
    selTo: new THREE.PointsMaterial({
      size: 26,
      sizeAttenuation: false,
      map: makeRingTexture(),
      transparent: true,
      depthTest: false,
    }),
    selFrom: new THREE.PointsMaterial({
      size: 18,
      sizeAttenuation: false,
      map: makeRingTexture(),
      color: sceneTheme().baseAccent,
      transparent: true,
      depthTest: false,
    }),
    selLine: new THREE.LineBasicMaterial({ color: sceneTheme().outline, depthTest: false, transparent: true }),
    highlight: new THREE.MeshBasicMaterial({ color: sceneTheme().outline, wireframe: true, transparent: true, opacity: 0.85, depthTest: false }),
  };
  private readonly ghostMaterials = new Map<string, { fill: THREE.Material; wire: THREE.Material }>();

  private readonly selection = {
    to: new THREE.Points(new THREE.BufferGeometry(), this.materials.selTo),
    from: new THREE.Points(new THREE.BufferGeometry(), this.materials.selFrom),
    line: new THREE.Line(new THREE.BufferGeometry(), this.materials.selLine),
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(sceneTheme().background, 1);
    this.renderer.domElement.classList.add('viewer-canvas');
    container.appendChild(this.renderer.domElement);

    // Lighting: sky/ground fill + a "headlight" that follows the camera, balanced so a
    // face turned to the viewer shows its DIFF_COLORS value almost exactly.
    const hemi = new THREE.HemisphereLight('#ffffff', '#b8b8b8', 0.5 * Math.PI);
    hemi.position.set(0, 1, 0);
    this.scene.add(hemi);
    const head = new THREE.DirectionalLight('#ffffff', 0.55 * Math.PI);
    head.position.set(0.35, 0.45, 0);
    head.target.position.set(0, 0, -1);
    this.camera.add(head, head.target);
    this.scene.add(this.camera);

    this.scene.add(this.content);
    this.content.add(this.overlay);
    for (const o of [this.selection.to, this.selection.from, this.selection.line]) {
      o.renderOrder = 30;
      o.visible = false;
      o.frustumCulled = false;
      this.overlay.add(o);
    }
    this.selection.line.renderOrder = 29;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => {
      this.updateClipPlanes();
      this.dirty = true;
    });
    this.camera.position.set(3, 2, 4);
    this.controls.update();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pointerDown = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    canvas.addEventListener('pointerup', (e) => {
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down || e.button !== 0 || down.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // it was a drag
      this.onPick?.(this.pick(e.clientX, e.clientY));
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.stopThemeWatch = onThemeChange(() => this.applyTheme());
    this.resize();
    this.loop();
  }

  /** Repaint in the current theme (theme.ts): background, edges, outlines, the base accent. */
  private applyTheme(): void {
    const t = sceneTheme();
    const m = this.materials;
    this.renderer.setClearColor(t.background, 1);
    m.wire.color.set(t.wire);
    m.wire.opacity = t.wireOpacity;
    m.ghost.color.set(t.baseAccent);
    m.ghost.opacity = t.ghostOpacity;
    m.ghostWire.color.set(t.baseAccent);
    m.selFrom.color.set(t.baseAccent);
    m.selLine.color.set(t.outline);
    m.highlight.color.set(t.outline);
    // The displacement vectors carry the base accent in their vertex colours: rebuild them.
    this.refreshColors();
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /** Show one mesh in neutral grey (only one side loaded so far). */
  showPreview(mesh: IMesh, side: 'base' | 'target'): void {
    this.clear();
    this.replay = () => this.showPreview(mesh, side);
    this.previewMode = true;
    this.origin.copy(centerOf(mesh.positions));
    this.content.position.copy(this.origin);
    const layer = buildFaceLayer(mesh, mesh.positions, null, this.origin);
    const obj = new THREE.Mesh(layer.geometry, this.materials.target);
    this.objects.target = obj;
    this.objects.targetLayer = layer;
    this.objects.targetWire = new THREE.Mesh(layer.geometry, this.materials.wire);
    this.content.add(obj, this.objects.targetWire);
    this.pickables = [
      { object: obj, layer: 'preview', side, mesh, positions: mesh.positions, faceMap: layer.faceMap, status: null },
    ];
    this.applyLayers();
    this.fit(boxOf(mesh.positions));
  }

  /** Show a full diff. Returns per-layer element counts for the UI. */
  showDiff(base: IMesh, target: IMesh, result: IDiffResult): ILayerCounts {
    this.clear();
    this.replay = () => void this.showDiff(base, target, result);
    this.previewMode = false;
    const matrix = isIdentityMatrix(result.alignment.matrix) ? null : result.alignment.matrix;
    const alignedBase = alignPositions(base.positions, matrix);
    this.origin.copy(centerOf(target.faceCount > 0 ? target.positions : alignedBase));
    this.content.position.copy(this.origin);

    const targetLayer = buildFaceLayer(target, target.positions, result.targetFaceStatus, this.origin);
    const removedLayer = buildFaceLayer(
      base,
      alignedBase,
      result.baseFaceStatus,
      this.origin,
      (s) => s === FaceStatus.Removed,
    );
    const ghostGeometry = buildIndexedGeometry(base, alignedBase, this.origin);
    const markers = buildMarkers(target, alignedBase, result, this.origin);
    const vectors = buildDisplacementVectors(target, alignedBase, result, this.origin);

    const o = this.objects;
    o.targetLayer = targetLayer;
    o.target = new THREE.Mesh(targetLayer.geometry, this.materials.target);
    o.targetWire = new THREE.Mesh(targetLayer.geometry, this.materials.wire);
    o.removed = new THREE.Mesh(removedLayer.geometry, this.materials.removed);
    o.removedWire = new THREE.Mesh(removedLayer.geometry, this.materials.wire);
    o.ghost = new THREE.Mesh(ghostGeometry, this.materials.ghost);
    o.ghostWire = new THREE.Mesh(ghostGeometry, this.materials.ghostWire);
    o.markers = new THREE.Points(markers.geometry, this.materials.markers);
    o.vectors = new THREE.LineSegments(vectors.geometry, this.materials.vectors);
    o.ghost.renderOrder = 5;
    o.ghostWire.renderOrder = 6;
    o.vectors.renderOrder = 20;
    this.content.add(o.target, o.targetWire, o.removed, o.removedWire, o.ghost, o.ghostWire, o.markers, o.vectors);

    this.pickables = [
      {
        object: o.target,
        layer: 'target',
        side: 'target',
        mesh: target,
        positions: target.positions,
        faceMap: targetLayer.faceMap,
        status: result.targetFaceStatus,
      },
      {
        object: o.removed,
        layer: 'removed',
        side: 'base',
        mesh: base,
        positions: alignedBase,
        faceMap: removedLayer.faceMap,
        status: result.baseFaceStatus,
      },
      {
        object: o.ghost,
        layer: 'ghost',
        side: 'base',
        mesh: base,
        positions: alignedBase,
        faceMap: null,
        status: result.baseFaceStatus,
      },
    ];
    this.applyLayers();

    const box = boxOf(target.positions).union(boxOf(alignedBase));
    this.fit(box);
    return {
      targetFaces: target.faceCount,
      changedTargetFaces: targetLayer.changedFaces,
      removedFaces: removedLayer.faceMap.length,
      markers: markers.counts.moved + markers.counts.added + markers.counts.removed,
      vectors: vectors.count,
    };
  }

  /**
   * Show ONE side of a diff (the before / after capture). 'base': the base mesh aligned into
   * target space, coloured by its own face status (removed red, moved yellow, unchanged grey).
   * 'target': the target mesh (added green, moved yellow, unchanged grey). The origin and the
   * framing are those of showDiff for the same pair, so a 'base' viewer and a 'target' viewer of
   * the same size draw an unchanged face on exactly the same pixels.
   */
  showSide(base: IMesh, target: IMesh, result: IDiffResult, side: 'base' | 'target'): void {
    this.clear();
    this.replay = () => this.showSide(base, target, result, side);
    this.previewMode = false;
    const matrix = isIdentityMatrix(result.alignment.matrix) ? null : result.alignment.matrix;
    const alignedBase = alignPositions(base.positions, matrix);
    this.origin.copy(centerOf(target.faceCount > 0 ? target.positions : alignedBase));
    this.content.position.copy(this.origin);
    const mesh = side === 'target' ? target : base;
    const positions = side === 'target' ? target.positions : alignedBase;
    const status = side === 'target' ? result.targetFaceStatus : result.baseFaceStatus;
    this.showLayer(buildFaceLayer(mesh, positions, status, this.origin), { layer: side, side, mesh, positions, status });
    this.fit(boxOf(target.positions).union(boxOf(alignedBase)));
  }

  /** Show one whole mesh in a single status colour (an added file green, a deleted one red). */
  showSingle(mesh: IMesh, side: 'base' | 'target', status: FaceStatusCode): void {
    this.clear();
    this.replay = () => this.showSingle(mesh, side, status);
    this.previewMode = false;
    this.origin.copy(centerOf(mesh.positions));
    this.content.position.copy(this.origin);
    const statuses = new Uint8Array(mesh.faceCount).fill(status);
    this.showLayer(buildFaceLayer(mesh, mesh.positions, statuses, this.origin), { layer: side, side, mesh, positions: mesh.positions, status: statuses });
    this.fit(boxOf(mesh.positions));
  }

  /** One coloured face layer as the whole scene (the "target" object slot, so layer toggles apply). */
  private showLayer(layer: IFaceLayer, pickable: Omit<IPickable, 'object' | 'faceMap'>): void {
    const obj = new THREE.Mesh(layer.geometry, this.materials.target);
    this.objects.target = obj;
    this.objects.targetLayer = layer;
    this.objects.targetWire = new THREE.Mesh(layer.geometry, this.materials.wire);
    this.content.add(obj, this.objects.targetWire);
    this.pickables = [{ ...pickable, object: obj, faceMap: layer.faceMap }];
    this.applyLayers();
  }

  /**
   * Frame `box` looking along `direction` (from the box towards the camera; both in model space;
   * default: the up axis's default view). Deterministic: two viewers of the same size framing the
   * same box the same way get identical cameras.
   */
  frame(box: THREE.Box3, direction?: Vec3): void {
    this.fit(box, direction);
  }

  /** Which model axis points up on screen. Changing it turns the model and re-frames it. */
  setUpAxis(up: UpAxis): void {
    if (up === this.up) return;
    this.up = up;
    this.content.rotation.x = up === 'z' ? -Math.PI / 2 : 0;
    this.content.updateMatrixWorld(true);
    if (this.lastFit) this.fit(this.lastFit.box, this.lastFit.direction ?? undefined);
    this.dirty = true;
  }

  get upAxis(): UpAxis {
    return this.up;
  }

  /**
   * Repaint the content in the current palette (view-options.ts applyPalette first). The camera,
   * the layer toggles and the selection stay as they are. The merge review redraws itself.
   */
  refreshColors(): void {
    this.materials.removed.color.set(diffColors().removed);
    const replay = this.replay;
    const selection = this.selectionState;
    if (replay) {
      this.holdCamera = true;
      try {
        replay();
      } finally {
        this.holdCamera = false;
      }
      if (selection) this.setSelection(selection);
    }
    this.dirty = true;
  }

  /** Model space → scene world (the content's rotation about the model centre). */
  private modelToWorld(): THREE.Matrix4 {
    this.content.updateMatrixWorld(true);
    return this.content.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(-this.origin.x, -this.origin.y, -this.origin.z));
  }

  toWorld(p: Vec3): THREE.Vector3 {
    return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.modelToWorld());
  }

  toModel(world: THREE.Vector3): Vec3 {
    const v = world.clone().applyMatrix4(this.modelToWorld().invert());
    return [v.x, v.y, v.z];
  }

  /** The camera position in model space. */
  eyeInModel(): Vec3 {
    return this.toModel(this.camera.position);
  }

  /** Camera position, look-at target, fov, aspect, near and far (to compare two viewers' framing). */
  cameraState(): number[] {
    const c = this.camera;
    return [...c.position.toArray(), ...this.controls.target.toArray(), c.fov, c.aspect, c.near, c.far];
  }

  /** Remove all model content (keeps camera). */
  clear(): void {
    this.setSelection(null);
    this.replay = null;
    const geometries = new Set<THREE.BufferGeometry>();
    for (const obj of Object.values(this.objects)) {
      if (obj instanceof THREE.Object3D) {
        this.content.remove(obj);
        if ('geometry' in obj && obj.geometry instanceof THREE.BufferGeometry) geometries.add(obj.geometry);
      }
    }
    this.clearMergeObjects(geometries);
    for (const g of geometries) g.dispose();
    this.objects = {};
    this.pickables = [];
    this.previewMode = false;
    this.dirty = true;
  }

  private clearMergeObjects(geometries: Set<THREE.BufferGeometry>): void {
    const m = this.merge;
    for (const obj of [m.mesh, m.wire, m.baseGhost, m.highlight, ...m.ghosts.flatMap((g) => g.objects)]) {
      if (!obj) continue;
      this.content.remove(obj);
      geometries.add(obj.geometry);
    }
    this.merge = { ghosts: [] };
  }

  // -------------------------------------------------------------------------
  // Merge review
  // -------------------------------------------------------------------------

  /**
   * Show a merged mesh coloured per face. `refit` false keeps the camera and origin (the same
   * merge re-resolved), so choosing a resolution never makes the view jump.
   */
  showMerge(merged: IMesh, kinds: MergeFaceKind[], base: IMesh, baseToMerged: THREE.Matrix4, opts: { refit: boolean }): IMergeLayer {
    const keep = !opts.refit && !!this.merge.mesh;
    this.clear(); // no replay: the merge review redraws itself (highlight and ghosts included)
    this.previewMode = false;
    if (!keep) {
      this.origin.copy(centerOf(merged.positions));
      this.content.position.copy(this.origin);
    }
    const layer = buildMergeLayer(merged, kinds, this.origin);
    const mesh = new THREE.Mesh(layer.geometry, this.materials.target);
    const wire = new THREE.Mesh(layer.geometry, this.materials.wire);
    const baseGhost = new THREE.Mesh(buildFaceSubset(base, allFaces(base.faceCount), baseToMerged, this.origin), this.materials.ghost);
    baseGhost.renderOrder = 5;
    this.merge = { layer, mesh, wire, baseGhost, ghosts: [] };
    this.content.add(mesh, wire, baseGhost);
    this.pickables = [{ object: mesh, layer: 'merged', side: 'merged', mesh: merged, positions: merged.positions, faceMap: layer.faceMap, status: null }];
    this.applyMergeLayers();
    if (!keep) this.fit(boxOf(merged.positions));
    return layer;
  }

  /** The recentring offset of the scene (geometry is stored as world − origin). */
  get sceneOrigin(): THREE.Vector3 {
    return this.origin.clone();
  }

  setMergeLayers(next: Partial<IMergeLayerVisibility>): void {
    this.mergeLayers = { ...this.mergeLayers, ...next };
    this.applyMergeLayers();
  }

  getMergeLayers(): IMergeLayerVisibility {
    return { ...this.mergeLayers };
  }

  /** Outline some merged faces (the selected conflict region); null clears it. */
  setMergeHighlight(merged: IMesh | null, faces: ArrayLike<number> | null): void {
    if (this.merge.highlight) {
      this.content.remove(this.merge.highlight);
      this.merge.highlight.geometry.dispose();
      this.merge.highlight = undefined;
    }
    if (merged && faces && faces.length > 0) {
      const obj = new THREE.Mesh(buildFaceSubset(merged, faces, null, this.origin), this.materials.highlight);
      obj.renderOrder = 25;
      this.merge.highlight = obj;
      this.content.add(obj);
    }
    this.dirty = true;
  }

  /** Replace the conflict previews (null clears them). */
  setMergeGhosts(ghosts: IGhostSpec[] | null): void {
    for (const g of this.merge.ghosts) {
      for (const o of g.objects) this.content.remove(o);
      g.objects[0]?.geometry.dispose();
    }
    this.merge.ghosts = [];
    for (const spec of ghosts ?? []) {
      const mats = this.ghostMaterial(spec.color);
      const fill = new THREE.Mesh(spec.geometry, mats.fill);
      const wire = new THREE.Mesh(spec.geometry, mats.wire);
      fill.renderOrder = 7;
      wire.renderOrder = 8;
      this.merge.ghosts.push({ label: spec.label, objects: [fill, wire] });
      this.content.add(fill, wire);
    }
    this.applyMergeLayers();
  }

  /**
   * Show one version's ghost filled (and every other ghost hidden) — a live preview of what a
   * resolution would look like; null returns to the outline-only previews of the layer toggles.
   */
  setMergeGhostEmphasis(label: IGhostSpec['label'] | null): void {
    this.ghostEmphasis = label;
    this.applyMergeLayers();
  }

  private ghostMaterial(color: string): { fill: THREE.Material; wire: THREE.Material } {
    let m = this.ghostMaterials.get(color);
    if (!m) {
      m = {
        fill: new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }),
        wire: new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.9, depthWrite: false }),
      };
      this.ghostMaterials.set(color, m);
    }
    return m;
  }

  private applyMergeLayers(): void {
    const L = this.mergeLayers;
    const m = this.merge;
    if (m.layer) m.layer.geometry.setDrawRange(0, (L.unchanged ? m.layer.faceMap.length : m.layer.changedFaces) * 3);
    if (m.wire) m.wire.visible = L.wireframe;
    if (m.baseGhost) m.baseGhost.visible = L.baseGhost;
    // Outlines per the layer toggles; while a resolution button is hovered, only that version, filled.
    const show = { base: L.previewBase, ours: L.previewOurs, theirs: L.previewTheirs };
    for (const g of m.ghosts) {
      const [fill, wire] = g.objects;
      const emphasised = this.ghostEmphasis === g.label;
      fill.visible = emphasised;
      wire.visible = this.ghostEmphasis ? emphasised : show[g.label];
    }
    this.dirty = true;
  }

  /** Screen position (CSS pixels, relative to the canvas) of a model-space point, or null if behind the camera. */
  project(p: Vec3): [number, number] | null {
    const v = this.toWorld(p).project(this.camera);
    if (v.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return [((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height];
  }

  setLayers(next: Partial<ILayerVisibility>): void {
    this.layers = { ...this.layers, ...next };
    this.applyLayers();
  }

  getLayers(): ILayerVisibility {
    return { ...this.layers };
  }

  private applyLayers(): void {
    const L = this.layers;
    const o = this.objects;
    const showTarget = L.target || this.previewMode;
    if (o.target) o.target.visible = showTarget;
    if (o.targetWire) o.targetWire.visible = showTarget && L.wireframe;
    if (o.targetLayer) {
      const hideUnchanged = !L.unchanged && !this.previewMode;
      const count = hideUnchanged ? o.targetLayer.changedFaces : o.targetLayer.faceMap.length;
      o.targetLayer.geometry.setDrawRange(0, count * 3);
    }
    if (o.removed) o.removed.visible = L.removed;
    if (o.removedWire) o.removedWire.visible = L.removed && L.wireframe;
    if (o.ghost) o.ghost.visible = L.ghost;
    if (o.ghostWire) o.ghostWire.visible = L.ghost;
    if (o.markers) o.markers.visible = L.markers;
    if (o.vectors) o.vectors.visible = L.vectors;
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Selection / picking
  // -------------------------------------------------------------------------

  /** Highlight a vertex change: ring at `to` (target), smaller ring at `from` (aligned base), line between. */
  setSelection(sel: { from: Vec3 | null; to: Vec3 | null } | null): void {
    this.selectionState = sel;
    const { to, from, line } = this.selection;
    const local = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]).sub(this.origin);
    to.visible = !!sel?.to;
    from.visible = !!sel?.from;
    line.visible = !!(sel?.to && sel?.from);
    if (sel?.to) to.geometry.setFromPoints([local(sel.to)]);
    if (sel?.from) from.geometry.setFromPoints([local(sel.from)]);
    if (sel?.to && sel?.from) line.geometry.setFromPoints([local(sel.from), local(sel.to)]);
    this.dirty = true;
  }

  /** Raycast the visible pickable layers at a client position. */
  pick(clientX: number, clientY: number): IPickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const visible = this.pickables.filter((p) => p.object.visible);
    const hits = this.raycaster.intersectObjects(
      visible.map((p) => p.object),
      false,
    );
    // Prefer real surfaces; the translucent ghost only when nothing else was hit.
    const hit = hits.find((h) => this.pickableOf(h.object)?.layer !== 'ghost') ?? hits[0];
    if (!hit || hit.faceIndex == null) return null;
    const p = this.pickableOf(hit.object)!;
    const face = p.faceMap ? p.faceMap[hit.faceIndex] : hit.faceIndex;
    const point: Vec3 = this.toModel(hit.point);
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < 3; j++) {
      const v = p.mesh.faces[face * 3 + j];
      const d = Math.hypot(
        p.positions[v * 3] - point[0],
        p.positions[v * 3 + 1] - point[1],
        p.positions[v * 3 + 2] - point[2],
      );
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return {
      side: p.side,
      vertex: best,
      face,
      faceStatus: p.status ? p.status[face] : null,
      layer: p.layer,
      point,
    };
  }

  private pickableOf(obj: THREE.Object3D): IPickable | undefined {
    return this.pickables.find((p) => p.object === obj);
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  /**
   * Frame `box` (model space) seen from `direction` (model space; default: the up axis's 3/4
   * view), at the distance where all 8 box corners fit with a margin.
   */
  private fit(modelBox: THREE.Box3, direction?: Vec3): void {
    this.lastFit = { box: modelBox.clone(), direction: direction ?? null };
    const toWorld = this.modelToWorld();
    // A turn of 0° or −90° about X keeps an axis-aligned box axis-aligned: no growth.
    const box = modelBox.isEmpty()
      ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
      : modelBox.clone().applyMatrix4(toWorld);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-9);
    this.sceneRadius = radius;
    // From the target towards the camera, in world space.
    const zAxis = new THREE.Vector3(...(direction ?? defaultView(this.up))).transformDirection(toWorld);
    const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    const margin = 0.82;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * margin;
    const tanH = tanV * this.camera.aspect;
    let distance = 0;
    const o = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      o.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const z = o.dot(zAxis);
      distance = Math.max(distance, z + Math.abs(o.dot(xAxis)) / tanH, z + Math.abs(o.dot(yAxis)) / tanV);
    }
    distance = Math.max(distance, radius * 1.05);
    this.home = { target: center.clone(), position: center.clone().addScaledVector(zAxis, distance) };
    this.controls.maxDistance = distance * 20;
    this.controls.minDistance = radius * 1e-4;
    if (!this.holdCamera) this.resetView();
  }

  resetView(): void {
    if (!this.home) return;
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.camera.up.set(0, 1, 0);
    this.controls.update();
    this.updateClipPlanes();
    this.dirty = true;
  }

  /** Orbit around a point (model space) without changing the viewing distance. */
  focus(point: Vec3): void {
    const p = this.toWorld(point);
    const offset = p.clone().sub(this.controls.target);
    this.controls.target.add(offset);
    this.camera.position.add(offset);
    this.controls.update();
    this.dirty = true;
  }

  private updateClipPlanes(): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    const far = d + this.controls.target.distanceTo(this.home?.target ?? this.controls.target) + this.sceneRadius * 4;
    const near = Math.max(d * 0.005, far * 1e-6);
    if (Math.abs(this.camera.near - near) > 1e-12 || Math.abs(this.camera.far - far) > 1e-9) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const moved = this.controls.update();
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      const waiters = this.renderWaiters;
      this.renderWaiters = [];
      for (const w of waiters) w();
    }
  };

  requestRender(): void {
    this.dirty = true;
  }

  /** Resolves once a frame containing all changes made so far has been drawn. */
  whenRendered(): Promise<void> {
    this.dirty = true;
    return new Promise((resolve) => this.renderWaiters.push(resolve));
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.stopThemeWatch();
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

/**
 * Pull a material's vertices 1.5% towards the eye in view space. Screen positions are
 * unchanged (x/z and y/z are preserved) but flat point sprites sitting on a surface vertex
 * are no longer half-buried in the sloped faces around that vertex.
 */
function withDepthBias<T extends THREE.Material>(material: T, factor = 0.985): T {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
	mvPosition.xyz *= ${factor.toFixed(4)};
	gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  material.customProgramCacheKey = () => `depth-bias-${factor}`;
  return material;
}

function allFaces(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

function centerOf(positions: ArrayLike<number>): THREE.Vector3 {
  const box = boxOf(positions);
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}
