/**
 * Three.js scene for one diff: target mesh coloured per face status, removed base faces,
 * a translucent base ghost, vertex markers, displacement vectors, a wireframe overlay and a
 * selection highlight. World space == diff TARGET space.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DIFF_COLORS, FaceStatus, type IDiffResult, type IMesh, type Vec3 } from '@polymerge/core';
import {
  BASE_ACCENT,
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
  side: 'base' | 'target';
  vertex: number;
  face: number;
  /** Status of the picked face (null in single-mesh preview). */
  faceStatus: number | null;
  layer: 'target' | 'removed' | 'ghost' | 'preview';
  /** Hit point, target space. */
  point: Vec3;
}

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
  side: 'base' | 'target';
  mesh: IMesh;
  /** Positions of `mesh` in target space. */
  positions: Float64Array;
  /** Draw triangle → mesh face (null = identity, for indexed geometry). */
  faceMap: Uint32Array | null;
  status: Uint8Array | null;
}

const BACKGROUND = '#0f141d';

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
  private pickables: IPickable[] = [];
  private previewMode = false;
  private origin = new THREE.Vector3();
  private sceneRadius = 1;
  private home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private dirty = true;
  private raf = 0;
  private renderWaiters: (() => void)[] = [];
  private pointerDown: { x: number; y: number; id: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;

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
      color: DIFF_COLORS.removed,
      flatShading: true,
      side: THREE.DoubleSide,
      // Behind coincident target faces: "what is there now" wins, red shows what is gone.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
    ghost: new THREE.MeshLambertMaterial({
      color: BASE_ACCENT,
      flatShading: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 3,
      polygonOffsetUnits: 3,
    }),
    ghostWire: new THREE.MeshBasicMaterial({
      color: BASE_ACCENT,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
    wire: new THREE.MeshBasicMaterial({
      color: '#0b0f17',
      wireframe: true,
      transparent: true,
      opacity: 0.5,
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
      color: BASE_ACCENT,
      transparent: true,
      depthTest: false,
    }),
    selLine: new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true }),
  };

  private readonly selection = {
    to: new THREE.Points(new THREE.BufferGeometry(), this.materials.selTo),
    from: new THREE.Points(new THREE.BufferGeometry(), this.materials.selFrom),
    line: new THREE.Line(new THREE.BufferGeometry(), this.materials.selLine),
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(BACKGROUND, 1);
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
    this.resize();
    this.loop();
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /** Show one mesh in neutral grey (only one side loaded so far). */
  showPreview(mesh: IMesh, side: 'base' | 'target'): void {
    this.clear();
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

  /** Remove all model content (keeps camera). */
  clear(): void {
    this.setSelection(null);
    const geometries = new Set<THREE.BufferGeometry>();
    for (const obj of Object.values(this.objects)) {
      if (obj instanceof THREE.Object3D) {
        this.content.remove(obj);
        if ('geometry' in obj && obj.geometry instanceof THREE.BufferGeometry) geometries.add(obj.geometry);
      }
    }
    for (const g of geometries) g.dispose();
    this.objects = {};
    this.pickables = [];
    this.previewMode = false;
    this.dirty = true;
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
    const point: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
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

  /** Frame `box`: view direction fixed, distance chosen so all 8 box corners fit with a margin. */
  private fit(box: THREE.Box3): void {
    if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-9);
    this.sceneRadius = radius;
    const zAxis = new THREE.Vector3(0.9, 0.62, 1.25).normalize(); // from target towards the camera
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
    this.resetView();
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

  /** Orbit around a point (target space) without changing the viewing distance. */
  focus(point: Vec3): void {
    const p = new THREE.Vector3(point[0], point[1], point[2]);
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

function centerOf(positions: ArrayLike<number>): THREE.Vector3 {
  const box = boxOf(positions);
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}
