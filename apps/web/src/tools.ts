/**
 * Review tools over the 3D view of a diff:
 *
 * - Section: cut the model with a plane along X, Y or Z, see the cut face, read its outlines,
 *   holes and area, and how the base's cut differs (dashed).
 * - Measure: click two points of the surface for the distance between them (a point snaps to a
 *   corner nearby). With the before / after split, measure from the old to the new geometry.
 * - Compare: the before / after slider, the base left of a divider and the target right of it.
 *
 * Keys: S, M, C toggle the tools; Esc clears the measurement.
 */
import * as THREE from 'three';
import { formatMeasure, formatUnit, sameMeasure, sectionMesh, type IDiffResult, type IMesh, type ISection, type ISectionLoop, type MetricUnit, type SectionAxis, type Vec3 } from 'polymerge-core';
import { h, setChildren } from './dom.js';
import { alignPositions, isIdentityMatrix } from './scene/layers.js';
import type { DiffViewer, IPickHit, ISectionDrawing } from './scene/viewer.js';

export interface IReviewData {
  base: IMesh | null;
  target: IMesh | null;
  result: IDiffResult | null;
}

/** One side's cut, for the hook. */
export interface ICutSummary {
  outlines: number;
  holes: number;
  open: number;
  /** Area of material in the cut. */
  area: number;
}

export interface IReviewHookState {
  section: { axis: SectionAxis; value: number; flip: boolean; target: ICutSummary | null; base: ICutSummary | null } | null;
  measure: { points: Vec3[]; distance: number | null } | null;
  compare: number | null;
}

type Tool = 'section' | 'measure' | 'compare';

const AXES: SectionAxis[] = ['x', 'y', 'z'];
const AXIS_INDEX: Record<SectionAxis, number> = { x: 0, y: 1, z: 2 };
/** Above this many faces the cut is recomputed when the slider is let go, not while it moves. */
const LIVE_CUT_FACES = 300_000;
/** A measure point snaps to a corner this close on screen (CSS px). */
const SNAP_PX = 10;

const SVG = 'http://www.w3.org/2000/svg';
function icon(d: string): SVGSVGElement {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  el.append(path);
  return el;
}
const ICONS: Record<Tool, string> = {
  // A box with a plane through it.
  section: 'M4 8l8-4 8 4v8l-8 4-8-4zM2 13l10 5 10-5',
  // A ruler.
  measure: 'M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  // A split square.
  compare: 'M4 4h16v16H4zM12 2v20',
};

export class ReviewTools {
  /** The toolbar and the tool cards (they stack under one another), and what goes over the view. */
  readonly toolbar: HTMLElement;
  readonly cards = h('div', { class: 'tool-cards' });
  readonly overlays: HTMLElement[];
  private readonly buttons: Record<Tool, HTMLButtonElement>;
  private readonly sectionCard = h('div', { class: 'tool-card hidden', dataset: { tool: 'section' } });
  private readonly measureCard = h('div', { class: 'tool-card hidden', dataset: { tool: 'measure' } });
  private readonly measureLabel = h('div', { class: 'measure-label hidden' });
  private readonly handle = h(
    'div',
    { class: 'compare-handle hidden', role: 'slider', 'aria-label': 'Before / after divider', tabindex: '0' },
    h('span', { class: 'compare-tag before' }, 'Before'),
    h('span', { class: 'compare-tag after' }, 'After'),
  );

  private section: { axis: SectionAxis; t: number; flip: boolean } | null = null;
  private cuts: { target: ISection | null; base: ISection | null } = { target: null, base: null };
  private measure: { points: { p: Vec3; snapped: boolean; side: string }[] } | null = null;
  private compare: number | null = null;
  /** The base in target space, for the current result. */
  private aligned: { result: IDiffResult; mesh: IMesh } | null = null;
  private pendingCut = 0;

  constructor(
    private readonly viewer: DiffViewer,
    private readonly stage: HTMLElement,
    private readonly data: () => IReviewData,
    private readonly changed: () => void,
  ) {
    const button = (tool: Tool, label: string, key: string) => {
      const b = h('button', { type: 'button', dataset: { tool }, title: `${label} (${key})`, 'aria-pressed': 'false' }, icon(ICONS[tool]), label);
      b.addEventListener('click', () => this.toggle(tool));
      return b;
    };
    this.buttons = { section: button('section', 'Section', 'S'), measure: button('measure', 'Measure', 'M'), compare: button('compare', 'Before / after', 'C') };
    this.toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Review tools' }, this.buttons.section, this.buttons.measure, this.buttons.compare);
    this.cards.append(this.sectionCard, this.measureCard);
    this.overlays = [this.measureLabel, this.handle];
    this.wireHandle();
    viewer.onAfterRender = () => this.placeLabels();
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const tool = ({ s: 'section', m: 'measure', c: 'compare' } as const)[e.key.toLowerCase() as 's' | 'm' | 'c'];
      if (tool && !this.buttons[tool].disabled) {
        e.preventDefault();
        this.toggle(tool);
      }
    });
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  isActive(tool: Tool): boolean {
    return tool === 'section' ? this.section !== null : tool === 'measure' ? this.measure !== null : this.compare !== null;
  }

  toggle(tool: Tool, on = !this.isActive(tool)): void {
    if (tool === 'section') {
      if (on && !this.section) {
        const axis = this.defaultAxis();
        this.section = { axis, t: this.firstCut(axis), flip: false };
      } else if (!on) this.section = null;
      this.updateSection(true);
    } else if (tool === 'measure') {
      this.measure = on ? { points: [] } : null;
      this.updateMeasure();
    } else {
      this.compare = on && this.viewer.canCompare ? 0.5 : null;
      this.updateCompare();
    }
    this.renderToolbar();
    this.changed();
  }

  /** New models or a new result: recompute what the tools show. */
  refresh(): void {
    const { base, target, result } = this.data();
    if (!result || this.aligned?.result !== result) this.aligned = null;
    if (result && base && !this.aligned) {
      const m = isIdentityMatrix(result.alignment.matrix) ? null : result.alignment.matrix;
      this.aligned = { result, mesh: { ...base, positions: alignPositions(base.positions, m) } };
    }
    if (!base && !target) {
      this.section = null;
      this.measure = null;
    }
    if (this.measure) this.measure.points = [];
    if (this.compare !== null && !this.viewer.canCompare) this.compare = null;
    this.updateSection(true);
    this.updateMeasure();
    this.updateCompare();
    this.renderToolbar();
  }

  /** Esc: clear the measurement first; false when there was nothing to clear. */
  escape(): boolean {
    if (this.measure && this.measure.points.length > 0) {
      this.measure.points = [];
      this.updateMeasure();
      this.changed();
      return true;
    }
    return false;
  }

  state(): IReviewHookState {
    const s = this.section;
    const plane = this.plane();
    const pts = this.measure?.points ?? [];
    return {
      section: s && plane ? { axis: s.axis, value: plane.value, flip: s.flip, target: summary(this.cuts.target), base: summary(this.cuts.base) } : null,
      measure: this.measure ? { points: pts.map((x) => x.p), distance: pts.length === 2 ? dist(pts[0].p, pts[1].p) : null } : null,
      compare: this.compare,
    };
  }

  private renderToolbar(): void {
    const { base, target } = this.data();
    const any = !!(base || target);
    this.buttons.section.disabled = !any;
    this.buttons.measure.disabled = !any;
    this.buttons.compare.disabled = !this.viewer.canCompare;
    this.buttons.compare.title = this.viewer.canCompare ? 'Before / after slider (C)' : 'Before / after needs both models';
    for (const tool of Object.keys(this.buttons) as Tool[]) this.buttons[tool].setAttribute('aria-pressed', String(this.isActive(tool)));
  }

  /** The meshes in target space: the target, and the base aligned to it (or the one model shown). */
  private meshes(): { target: IMesh | null; base: IMesh | null } {
    const { base, target, result } = this.data();
    if (result) return { target, base: this.aligned?.mesh ?? null };
    return { target: target ?? base, base: null };
  }

  private unit(): MetricUnit | undefined {
    const { target, base } = this.meshes();
    const m = target ?? base;
    return m ? formatUnit(m.metadata.format) : undefined;
  }

  private bounds(): { min: Vec3; max: Vec3 } | null {
    const { target, base } = this.meshes();
    const boxes = [target, base].filter((m): m is IMesh => !!m && m.vertexCount > 0).map((m) => boxOf(m.positions));
    if (boxes.length === 0) return null;
    return {
      min: [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]))) as Vec3,
      max: [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]))) as Vec3,
    };
  }

  /** Cut across the model's longest side by default... except that Z (top down) reads best for a flat part. */
  private defaultAxis(): SectionAxis {
    const b = this.bounds();
    if (!b) return 'z';
    const size = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
    const up = this.viewer.upAxis === 'z' ? 2 : 1;
    // Horizontal cut (along the up axis) unless the model is very flat that way.
    return size[up] > 0.05 * Math.max(...size) ? AXES[up] : AXES[size.indexOf(Math.max(...size))];
  }

  // -------------------------------------------------------------------------
  // Section
  // -------------------------------------------------------------------------

  /** Where a new section starts: the middle, or the nearest position to it that cuts something. */
  private firstCut(axis: SectionAxis): number {
    const { target, base } = this.meshes();
    const mesh = target ?? base;
    const b = this.bounds();
    if (!mesh || !b) return 0.5;
    const k = AXIS_INDEX[axis];
    for (let step = 0; step <= 9; step++) {
      for (const t of step === 0 ? [0.5] : [0.5 - 0.05 * step, 0.5 + 0.05 * step]) {
        if (sectionMesh(mesh, axis, b.min[k] + t * (b.max[k] - b.min[k])).loops.length > 0) return t;
      }
    }
    return 0.5;
  }

  private plane(): { axis: SectionAxis; value: number; flip: boolean } | null {
    const s = this.section;
    const b = this.bounds();
    if (!s || !b) return null;
    const k = AXIS_INDEX[s.axis];
    return { axis: s.axis, value: b.min[k] + s.t * (b.max[k] - b.min[k]), flip: s.flip };
  }

  /** Apply the plane; recompute the cut now (`cut`) or when the slider is let go (big models). */
  private updateSection(cut: boolean): void {
    const plane = this.plane();
    this.viewer.setSection(plane);
    if (!plane) {
      this.cuts = { target: null, base: null };
      this.viewer.setSectionDrawing(null, null);
      this.sectionCard.classList.add('hidden');
      return;
    }
    if (cut) this.computeCut();
    this.renderSectionCard();
  }

  private computeCut(): void {
    const plane = this.plane();
    if (!plane) return;
    const { target, base } = this.meshes();
    this.cuts = {
      target: target ? sectionMesh(target, plane.axis, plane.value) : null,
      base: base ? sectionMesh(base, plane.axis, plane.value) : null,
    };
    this.viewer.setSectionDrawing(this.cuts.target ? drawing(this.cuts.target) : null, this.cuts.base ? drawing(this.cuts.base) : null);
  }

  private renderSectionCard(): void {
    const s = this.section!;
    const plane = this.plane()!;
    const unit = this.unit();
    const card = this.sectionCard;
    card.classList.remove('hidden');
    const b = this.bounds()!;
    const k = AXIS_INDEX[s.axis];
    const lo = b.min[k];
    const hi = b.max[k];

    const axisButtons = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Section axis' },
      AXES.map((a) =>
        h('button', { type: 'button', 'aria-pressed': String(a === s.axis), dataset: { axis: a }, onclick: () => this.setSection({ axis: a }) }, a.toUpperCase()),
      ),
    );
    const slider = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: String(Math.round(s.t * 1000)), 'aria-label': 'Section position' });
    const value = h('input', { type: 'number', step: 'any', class: 'value', value: trim(plane.value), 'aria-label': `${s.axis} of the section plane`, style: { width: '84px' } });
    const big = (this.meshes().target?.faceCount ?? 0) + (this.meshes().base?.faceCount ?? 0) > LIVE_CUT_FACES;
    slider.addEventListener('input', () => {
      this.section!.t = Number(slider.value) / 1000;
      value.value = trim(this.plane()!.value);
      this.viewer.setSection(this.plane());
      if (!big) this.scheduleCut();
    });
    slider.addEventListener('change', () => this.scheduleCut());
    value.addEventListener('change', () => {
      const v = Number(value.value);
      if (!Number.isFinite(v) || hi === lo) return;
      this.setSection({ t: Math.min(1, Math.max(0, (v - lo) / (hi - lo))) });
    });
    const flip = h(
      'button',
      { type: 'button', class: 'small', 'aria-pressed': String(s.flip), title: 'Keep the other half', onclick: () => this.setSection({ flip: !s.flip }) },
      'Flip',
    );
    setChildren(
      card,
      h('div', { class: 'tool-row' }, axisButtons, slider, value, unit ? h('span', { class: 'muted' }, unit) : null, flip),
      h('div', { class: 'tool-readout', dataset: { readout: 'section' } }, this.sectionReadout(unit)),
    );
  }

  private sectionReadout(unit: MetricUnit | undefined): (HTMLElement | string)[] {
    const { target, base } = this.cuts;
    const area = (x: number) => formatMeasure(Math.abs(x), 2, unit);
    const line = (label: string, s: ISection | null) => {
      if (!s) return null;
      const c = summary(s)!;
      if (s.loops.length === 0) return h('div', null, h('strong', null, label), ' — the plane misses it');
      const parts = [plural(c.outlines, 'outline'), c.holes > 0 ? plural(c.holes, 'hole') : '', c.open > 0 ? plural(c.open, 'open edge') : ''].filter(Boolean);
      const circles = s.loops.filter((l) => l.closed && l.area < 0 && l.circleDiameter !== null).map((l) => `Ø${formatMeasure(l.circleDiameter!, 1, unit)}`);
      return h('div', null, h('strong', null, label), ` ${parts.join(', ')} · material ${area(c.area)}${circles.length ? ` · holes ${[...new Set(circles)].slice(0, 3).join(', ')}` : ''}`);
    };
    const out: (HTMLElement | string)[] = [];
    const t = line(base ? 'After' : 'Cut', target);
    const b = line('Before', base);
    if (t) out.push(t);
    if (b) out.push(b);
    if (target && base) {
      const d = target.area - base.area;
      const pct = base.area !== 0 ? ` (${d >= 0 ? '+' : '−'}${Math.abs((100 * d) / base.area).toFixed(1)}%)` : '';
      out.push(h('div', null, h('strong', null, 'Change'), sameMeasure(base.area, target.area) ? ' none in this cut' : ` material ${d > 0 ? '+' : '−'}${area(d)}${pct}`));
    }
    if (out.length > 0 && !unit) out.push(h('div', { class: 'tool-help' }, 'In the file’s own units.'));
    return out;
  }

  private setSection(change: Partial<{ axis: SectionAxis; t: number; flip: boolean }>): void {
    if (!this.section) return;
    Object.assign(this.section, change);
    this.updateSection(true);
    this.changed();
  }

  private scheduleCut(): void {
    cancelAnimationFrame(this.pendingCut);
    this.pendingCut = requestAnimationFrame(() => {
      this.computeCut();
      const readout = this.sectionCard.querySelector<HTMLElement>('[data-readout="section"]');
      if (readout) setChildren(readout, this.sectionReadout(this.unit()));
      this.changed();
    });
  }

  // -------------------------------------------------------------------------
  // Measure
  // -------------------------------------------------------------------------

  /** A click on the model. True when the measure tool took it (no vertex inspection then). */
  pick(hit: IPickHit | null): boolean {
    if (!this.measure) return false;
    if (!hit) return true;
    const pts = this.measure.points;
    if (pts.length >= 2) pts.length = 0;
    pts.push(this.snap(hit));
    this.updateMeasure();
    this.changed();
    return true;
  }

  /** The clicked point, or the corner of the clicked triangle when it is within SNAP_PX on screen. */
  private snap(hit: IPickHit): { p: Vec3; snapped: boolean; side: string } {
    const { base, target, result } = this.data();
    const mesh = hit.side === 'base' ? base : target;
    const positions = hit.layer === 'preview' || !result ? mesh?.positions : hit.side === 'base' ? this.aligned?.mesh.positions : target?.positions;
    const side = hit.layer === 'preview' ? (hit.side === 'base' ? 'base' : 'target') : hit.side;
    if (positions && hit.vertex >= 0) {
      const v: Vec3 = [positions[hit.vertex * 3], positions[hit.vertex * 3 + 1], positions[hit.vertex * 3 + 2]];
      const at = this.viewer.project(v);
      if (at && Math.hypot(at[0] - hit.screen[0], at[1] - hit.screen[1]) <= SNAP_PX) return { p: v, snapped: true, side };
    }
    return { p: hit.point, snapped: false, side };
  }

  private updateMeasure(): void {
    const m = this.measure;
    this.viewer.setMeasure(m ? m.points.map((x) => x.p) : []);
    if (!m) {
      this.measureCard.classList.add('hidden');
      this.measureLabel.classList.add('hidden');
      return;
    }
    const unit = this.unit();
    const len = (x: number) => formatMeasure(x, 1, unit);
    const pts = m.points;
    this.measureCard.classList.remove('hidden');
    let body: (HTMLElement | string | null)[];
    if (pts.length < 2) {
      body = [
        h('div', { class: 'tool-help' }, pts.length === 0 ? 'Click a point on the model.' : 'Now click a second point.', ' Points snap to a corner nearby.'),
        pts.length === 1 ? h('div', { class: 'tool-readout' }, h('strong', null, 'From'), ` ${fmtPoint(pts[0].p)}`) : null,
      ];
      this.measureLabel.classList.add('hidden');
    } else {
      const [a, b] = pts;
      const d = dist(a.p, b.p);
      const delta = [0, 1, 2].map((k) => b.p[k] - a.p[k]);
      const sides = a.side !== b.side && a.side !== 'target' ? ` · from the ${a.side === 'base' ? 'before' : a.side} to the ${b.side === 'base' ? 'before' : 'after'} model` : '';
      body = [
        h(
          'div',
          { class: 'tool-readout', dataset: { readout: 'measure' } },
          h('strong', null, `Distance ${len(d)}`),
          h('span', { class: 'deltas' }, `Δx ${trim(delta[0])} · Δy ${trim(delta[1])} · Δz ${trim(delta[2])}`),
          sides,
        ),
        h('div', { class: 'tool-help' }, `${fmtPoint(a.p)} → ${fmtPoint(b.p)}${a.snapped || b.snapped ? ' (snapped to corners)' : ''}. Click again to start over; Esc clears.`),
      ];
      this.measureLabel.textContent = len(d);
      this.measureLabel.classList.remove('hidden');
    }
    setChildren(
      this.measureCard,
      h('div', { class: 'tool-row' }, h('strong', null, 'Measure'), h('span', { style: { flex: '1' } }), h('button', { type: 'button', class: 'small', onclick: () => this.escape() }, 'Clear')),
      body,
    );
    this.placeLabels();
  }

  // -------------------------------------------------------------------------
  // Before / after
  // -------------------------------------------------------------------------

  private updateCompare(): void {
    this.viewer.setCompare(this.compare);
    this.handle.classList.toggle('hidden', this.compare === null);
    if (this.compare !== null) {
      this.handle.style.left = `${this.compare * 100}%`;
      this.handle.setAttribute('aria-valuenow', String(Math.round(this.compare * 100)));
    }
  }

  private wireHandle(): void {
    const move = (clientX: number) => {
      const rect = this.stage.getBoundingClientRect();
      this.compare = Math.min(0.98, Math.max(0.02, (clientX - rect.left) / rect.width));
      this.updateCompare();
    };
    this.handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => move(ev.clientX);
      const onUp = () => {
        this.handle.removeEventListener('pointermove', onMove);
        this.handle.removeEventListener('pointerup', onUp);
        this.changed();
      };
      this.handle.addEventListener('pointermove', onMove);
      this.handle.addEventListener('pointerup', onUp);
    });
    this.handle.addEventListener('keydown', (e) => {
      if (this.compare === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      this.compare = Math.min(0.98, Math.max(0.02, this.compare + (e.key === 'ArrowLeft' ? -0.02 : 0.02)));
      this.updateCompare();
      this.changed();
    });
  }

  /** Keep the distance label at the middle of the measure line. */
  private placeLabels(): void {
    const pts = this.measure?.points ?? [];
    if (pts.length !== 2) return;
    const mid: Vec3 = [0, 1, 2].map((k) => (pts[0].p[k] + pts[1].p[k]) / 2) as Vec3;
    const at = this.viewer.project(mid);
    this.measureLabel.classList.toggle('hidden', !at);
    if (at) {
      this.measureLabel.style.left = `${at[0]}px`;
      this.measureLabel.style.top = `${at[1]}px`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** A number for people: up to 4 decimals, no float noise. */
function trim(x: number): string {
  if (Math.abs(x) < 1e-9) return '0';
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-4) return x.toExponential(3);
  return String(Number(x.toFixed(4)));
}

function fmtPoint(p: Vec3): string {
  return `(${p.map(trim).join(', ')})`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function boxOf(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function summary(s: ISection | null): ICutSummary | null {
  if (!s) return null;
  return {
    outlines: s.loops.filter((l) => l.closed && l.area > 0).length,
    holes: s.loops.filter((l) => l.closed && l.area < 0).length,
    open: s.loops.filter((l) => !l.closed).length,
    area: s.area,
  };
}

/** Is (u, v) inside the loop (its points in the plane's 2D coordinates)? */
function inside(loop: ISectionLoop, ui: number, vi: number, u: number, v: number): boolean {
  let hit = false;
  const p = loop.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [ai, aj] = [p[i][vi], p[j][vi]];
    if (ai > v !== aj > v && u < ((p[j][ui] - p[i][ui]) * (v - ai)) / (aj - ai) + p[i][ui]) hit = !hit;
  }
  return hit;
}

/** A cut as triangles (each outline with the holes inside it) and outline segments, model space. */
export function drawing(s: ISection): ISectionDrawing {
  const ui = AXIS_INDEX[s.uAxis];
  const vi = AXIS_INDEX[s.vAxis];
  let segments = 0;
  for (const l of s.loops) segments += l.closed ? l.points.length : Math.max(0, l.points.length - 1);
  const lines = new Float32Array(segments * 6);
  let o = 0;
  for (const l of s.loops) {
    const n = l.points.length;
    for (let i = 0; i < (l.closed ? n : n - 1); i++) {
      const a = l.points[i];
      const b = l.points[(i + 1) % n];
      lines.set(a, o);
      lines.set(b, o + 3);
      o += 6;
    }
  }
  const closed = s.loops.filter((l) => l.closed && l.points.length >= 3);
  // Smallest outline first, so a hole goes to the innermost outline around it.
  const outlines = closed.filter((l) => l.area > 0).sort((a, b) => a.area - b.area);
  const holesOf = new Map<ISectionLoop, ISectionLoop[]>(outlines.map((l) => [l, []]));
  for (const hole of closed.filter((l) => l.area < 0)) {
    const [u, v] = [hole.points[0][ui], hole.points[0][vi]];
    const owner = outlines.find((l) => l.area > -hole.area && inside(l, ui, vi, u, v));
    if (owner) holesOf.get(owner)!.push(hole);
  }
  const tris: number[] = [];
  for (const [outline, holes] of holesOf) {
    const loops = [outline, ...holes].map((l) => dropClosingPoint(l.points));
    const flat = loops.map((pts) => pts.map((p) => new THREE.Vector2(p[ui], p[vi])));
    const all = loops.flat();
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(flat[0], flat.slice(1))) tris.push(...all[a], ...all[b], ...all[c]);
  }
  return { fill: new Float32Array(tris), lines };
}

/** Earcut wants each ring once round, without the first point repeated at the end. */
function dropClosingPoint(points: Vec3[]): Vec3[] {
  const [a, b] = [points[0], points[points.length - 1]];
  return points.length > 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] ? points.slice(0, -1) : points;
}
