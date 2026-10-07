/**
 * Capture mode (`?capture=1`): a fixed-size before / after card made for screenshots. It is what
 * the polymerge GitHub Action puts in pull-request comments (action/render.mjs); no panel, no
 * interaction.
 *
 *   ?capture=1&base=<url>&target=<url>    a changed model: each side coloured by its diff status
 *   ?capture=1&target=<url>               an added file: after only, all green
 *   ?capture=1&base=<url>                 a deleted file: before only, all red
 *   &before=<label>&after=<label>         short labels next to the panel titles (commit ids)
 *
 * The two panels are separate DiffViewers of the same size given the SAME box and view direction,
 * so their cameras are identical and an unchanged face lands on the same pixels in both. The view
 * is the viewer's default 3/4 view, mirrored towards the side of the model where the changes are.
 */
import {
  FaceStatus,
  summarizeMesh,
  type IDiffResult,
  type IMesh,
  type SourceFormat,
  type Vec3,
} from 'polymerge-core';
import { h, swatch } from './dom.js';
import { DiffEngine } from './engine.js';
import { publish, setViewProvider, type ICaptureHookState, type IPolymergeHook } from './hook.js';
import { alignPositions, boxOf, isIdentityMatrix } from './scene/layers.js';
import { DEFAULT_VIEW, defaultView, DiffViewer } from './scene/viewer.js';
import { loadFromUrl, pairLoads, type ILoadedMesh } from './sources.js';
import { themeName } from './theme.js';
import { defaultUpAxis, DIFF_CSS, paletteName, parseUpAxis, type UpAxis } from './view-options.js';

type Side = 'base' | 'target';

interface IPanel {
  root: HTMLElement;
  viewer: DiffViewer;
  label: HTMLElement;
  empty: HTMLElement;
}

/** How far off-centre (a fraction of the model's radius) the changes must sit before the view turns to them. */
const FACING_THRESHOLD = 0.15;

export class CaptureApp {
  private readonly engine = new DiffEngine(new URLSearchParams(location.search).get('worker') !== '0');
  private readonly card: HTMLElement;
  private readonly panels: Record<Side, IPanel>;
  private readonly note = h('span', { class: 'cap-note' });
  private readonly error = h('div', { class: 'cap-error hidden', role: 'alert' });
  private result: IDiffResult | null = null;
  private meshes: Partial<Record<Side, IMesh>> = {};
  /** ?up= (null: by format). */
  private upParam: UpAxis | null = null;

  constructor(root: HTMLElement) {
    const shell = (side: Side, title: string) => {
      const viewport = h('div', { class: 'cap-viewport' });
      const label = h('span', { class: 'cap-label' });
      const empty = h('div', { class: 'cap-empty hidden' });
      const el = h('section', { class: 'cap-panel', dataset: { side } }, viewport, h('header', { class: 'cap-title' }, h('strong', null, title), label), empty);
      return { el, viewport, label, empty };
    };
    const before = shell('base', 'Before');
    const after = shell('target', 'After');
    const legend = h(
      'footer',
      { class: 'cap-legend' },
      ([
        [DIFF_CSS.modified, 'Moved'],
        [DIFF_CSS.added, 'Added'],
        [DIFF_CSS.removed, 'Removed'],
        [DIFF_CSS.unchanged, 'Unchanged'],
      ] as const).map(([c, l]) => h('span', { class: 'cap-key' }, swatch(c), l)),
      this.note,
      h('span', { class: 'cap-brand' }, 'polymerge'),
    );
    this.card = h('div', { id: 'capture', class: 'capture' }, h('div', { class: 'cap-panels' }, before.el, after.el), legend, this.error);
    root.append(this.card);
    // The viewers measure their containers, so they are created once the card is in the page.
    const panel = (p: typeof before): IPanel => ({ root: p.el, viewer: new DiffViewer(p.viewport), label: p.label, empty: p.empty });
    this.panels = { base: panel(before), target: panel(after) };
    setViewProvider(() => ({ up: this.panels.target.viewer.upAxis, palette: paletteName(), theme: themeName() }));
    publish({ state: 'idle', mode: 'capture' });
  }

  /** Both panels: the URL's up axis, else Z for STEP and Y otherwise. */
  private setUp(formats: (SourceFormat | undefined)[]): UpAxis {
    const up = this.upParam ?? defaultUpAxis(formats);
    for (const p of Object.values(this.panels)) p.viewer.setUpAxis(up);
    return up;
  }

  async start(params: URLSearchParams): Promise<void> {
    const label = (key: string) => (params.get(key) ?? '').slice(0, 40);
    this.panels.base.label.textContent = label('before');
    this.panels.target.label.textContent = label('after');
    const baseUrl = params.get('base');
    const targetUrl = params.get('target');
    this.upParam = parseUpAxis(params.get('up'));
    publish({ state: 'loading', mode: 'capture' });
    try {
      if (!baseUrl && !targetUrl) throw new Error('capture mode needs ?base= and/or ?target=');
      const [base, target] = await Promise.all(
        pairLoads(baseUrl ? (o) => loadFromUrl(baseUrl, undefined, o) : null, targetUrl ? (o) => loadFromUrl(targetUrl, undefined, o) : null),
      );
      if (base && target) await this.showDiff(base, target);
      else if (target) this.showOne('target', target.mesh, FaceStatus.Added, 'New file: not in the base');
      else if (base) this.showOne('base', base.mesh, FaceStatus.Removed, 'Deleted in this change');
      await Promise.all(Object.values(this.panels).map((p) => p.viewer.whenRendered()));
    } catch (err) {
      const message = err instanceof Error ? `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}` : String(err);
      console.error('[polymerge] capture failed:', err);
      this.error.textContent = message;
      this.error.classList.remove('hidden');
      publish({ state: 'error', mode: 'capture', error: message });
    }
  }

  private async showDiff(base: ILoadedMesh, target: ILoadedMesh): Promise<void> {
    const result = await this.engine.run(base.mesh, target.mesh, {}, (level, m) => {
      if (level !== 'debug') console.info(m);
    });
    this.result = result;
    this.meshes = { base: base.mesh, target: target.mesh };
    const matrix = isIdentityMatrix(result.alignment.matrix) ? null : result.alignment.matrix;
    const alignedBase = alignPositions(base.mesh.positions, matrix);
    const box = boxOf(target.mesh.positions).union(boxOf(alignedBase));
    const up = this.setUp([base.mesh.metadata.format, target.mesh.metadata.format]);
    const direction = facingChanges(result, base.mesh, alignedBase, target.mesh, box, defaultView(up));
    for (const side of ['base', 'target'] as const) {
      const { viewer } = this.panels[side];
      viewer.showSide(base.mesh, target.mesh, result, side);
      viewer.frame(box, direction);
    }
    if (!result.alignment.isIdentity) {
      const al = result.alignment;
      const how = al.units ? `${al.units.from} → ${al.units.to}` : al.scale !== 1 ? `×${Number(al.scale.toPrecision(4))}` : 'whole-model move';
      this.note.textContent = `Before aligned to after (${how})`;
    }
    this.publishReady('diff', direction);
  }

  private showOne(side: Side, mesh: IMesh, status: typeof FaceStatus.Added | typeof FaceStatus.Removed, emptyText: string): void {
    this.meshes = { [side]: mesh };
    const up = this.setUp([mesh.metadata.format]);
    this.panels[side].viewer.showSingle(mesh, side, status);
    const other = this.panels[side === 'base' ? 'target' : 'base'];
    other.empty.textContent = emptyText;
    other.empty.classList.remove('hidden');
    this.publishReady(side === 'target' ? 'added' : 'deleted', defaultView(up));
  }

  private publishReady(kind: ICaptureHookState['kind'], direction: Vec3): void {
    const cardRect = this.card.getBoundingClientRect();
    const capture: ICaptureHookState = {
      kind,
      direction,
      panels: (['base', 'target'] as const).map((side) => {
        const p = this.panels[side];
        const r = p.viewer.renderer.domElement.getBoundingClientRect();
        return {
          side,
          empty: !this.meshes[side],
          rect: [r.left - cardRect.left, r.top - cardRect.top, r.width, r.height],
          camera: p.viewer.cameraState(),
        };
      }),
    };
    const hook: IPolymergeHook = { state: 'ready', mode: 'capture', capture, engine: this.engine.mode };
    const r = this.result;
    if (r) {
      Object.assign(hook, { tier: r.tier, tierName: r.tierName, stats: r.stats, base: r.base, target: r.target, parts: r.parts.length });
    } else {
      if (this.meshes.base) hook.base = summarizeMesh(this.meshes.base);
      if (this.meshes.target) hook.target = summarizeMesh(this.meshes.target);
    }
    publish(hook);
  }
}

/**
 * View direction for a diff: the default 3/4 view (`view`, model space), turned on every axis
 * where the changed faces (both versions of them) clearly sit on the other side of the model, so
 * the changes face the camera instead of hiding behind the model. Changes all round the model
 * keep the default.
 */
export function facingChanges(
  result: IDiffResult,
  base: IMesh,
  alignedBase: Float64Array,
  target: IMesh,
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  view: Vec3 = DEFAULT_VIEW,
): Vec3 {
  const sum = [0, 0, 0];
  let n = 0;
  const add = (positions: Float64Array, faces: Uint32Array, status: Uint8Array) => {
    for (let f = 0; f < status.length; f++) {
      if (status[f] === FaceStatus.Unchanged) continue;
      for (let j = 0; j < 3; j++) {
        const v = faces[f * 3 + j] * 3;
        sum[0] += positions[v];
        sum[1] += positions[v + 1];
        sum[2] += positions[v + 2];
        n++;
      }
    }
  };
  add(target.positions, target.faces, result.targetFaceStatus);
  add(alignedBase, base.faces, result.baseFaceStatus);
  const dir: Vec3 = [...view];
  const min = [box.min.x, box.min.y, box.min.z];
  const max = [box.max.x, box.max.y, box.max.z];
  // Offsets are measured against the whole model's size, so a thin axis (a plate's thickness)
  // never turns the view on its own.
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  if (n === 0 || !(radius > 0)) return dir;
  for (let k = 0; k < 3; k++) {
    const offset = (sum[k] / n - (min[k] + max[k]) / 2) / radius;
    if (offset < -FACING_THRESHOLD) dir[k] = -Math.abs(dir[k]);
    else if (offset > FACING_THRESHOLD) dir[k] = Math.abs(dir[k]);
  }
  return dir;
}
