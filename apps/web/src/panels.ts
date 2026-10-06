/** Render functions for the side-panel sections and the inspector card. */
import * as THREE from 'three';
import {
  FaceStatus,
  VertexStatus,
  displayUnit,
  formatChange,
  formatMeasure,
  stepInfo,
  volumeNote,
  type IDiffResult,
  type IMesh,
  type IMeshMetrics,
  type IMetricsComparison,
  type ITierAttempt,
  type IVertexChange,
  type MetricUnit,
  type Vec3,
} from 'polymerge-core';
import { h, swatch } from './dom.js';
import { DIFF_CSS } from './view-options.js';
import { fmtBytes, fmtInt, fmtMs, fmtNum, fmtSource, fmtVec } from './format.js';
import type { ILoadedMesh } from './sources.js';
import type { IPickHit } from './scene/viewer.js';

export const VERTEX_STATUS_LABEL: Record<number, string> = {
  [VertexStatus.Unchanged]: 'Unchanged',
  [VertexStatus.Moved]: 'Moved',
  [VertexStatus.Added]: 'Added',
  [VertexStatus.Removed]: 'Removed',
};
export const VERTEX_STATUS_COLOR: Record<number, string> = {
  [VertexStatus.Unchanged]: DIFF_CSS.unchanged,
  [VertexStatus.Moved]: DIFF_CSS.modified,
  [VertexStatus.Added]: DIFF_CSS.added,
  [VertexStatus.Removed]: DIFF_CSS.removed,
};
export const FACE_STATUS_LABEL: Record<number, string> = {
  [FaceStatus.Unchanged]: 'Unchanged',
  [FaceStatus.Modified]: 'Modified',
  [FaceStatus.Added]: 'Added',
  [FaceStatus.Removed]: 'Removed',
};
export const FACE_STATUS_COLOR: Record<number, string> = {
  [FaceStatus.Unchanged]: DIFF_CSS.unchanged,
  [FaceStatus.Modified]: DIFF_CSS.modified,
  [FaceStatus.Added]: DIFF_CSS.added,
  [FaceStatus.Removed]: DIFF_CSS.removed,
};

/** Tier badge + counts table + displacement + alignment. */
export function renderSummary(result: IDiffResult): HTMLElement[] {
  const s = result.stats;
  const accepted = result.attempts.find((a) => a.accepted);
  const rows: [string, string, number, number][] = [
    [DIFF_CSS.unchanged, 'Unchanged', s.vertices.unchanged, s.faces.unchanged],
    [DIFF_CSS.modified, 'Moved / Modified', s.vertices.moved, s.faces.modified],
    [DIFF_CSS.added, 'Added', s.vertices.added, s.faces.added],
    [DIFF_CSS.removed, 'Removed', s.vertices.removed, s.faces.removed],
  ];
  const out: HTMLElement[] = [
    h(
      'div',
      { class: 'tier-badge', dataset: { tier: String(result.tier) } },
      h('div', { class: 'tier-num' }, `Tier ${result.tier}`),
      h('div', { class: 'tier-name', title: result.tierName }, stripTierPrefix(result.tierName, result.tier)),
      h(
        'div',
        { class: 'tier-meta' },
        accepted ? `score ${fmtNum(accepted.score, 3)} ≥ ${fmtNum(accepted.threshold, 3)} · ` : '',
        `diff ${fmtMs(result.durationMs)}`,
      ),
    ),
    h(
      'table',
      { class: 'counts' },
      h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Vertices'), h('th', null, 'Faces'))),
      h(
        'tbody',
        null,
        rows.map(([color, label, v, f]) =>
          h('tr', null, h('td', null, swatch(color), label), h('td', { class: 'num' }, fmtInt(v)), h('td', { class: 'num' }, fmtInt(f))),
        ),
      ),
      h(
        'tfoot',
        null,
        h('tr', null, h('td', null, 'Base total'), h('td', { class: 'num' }, fmtInt(result.base.vertexCount)), h('td', { class: 'num' }, fmtInt(result.base.faceCount))),
        h('tr', null, h('td', null, 'Target total'), h('td', { class: 'num' }, fmtInt(result.target.vertexCount)), h('td', { class: 'num' }, fmtInt(result.target.faceCount))),
      ),
    ),
    kv([
      ['Max displacement', fmtNum(s.maxDisplacement)],
      ['Mean displacement', fmtNum(s.meanDisplacement)],
      ['Move ε / surface tol.', `${fmtNum(result.moveEpsilon)} / ${fmtNum(result.surfaceTolerance)}`],
    ]),
  ];
  if (result.metrics) out.push(h('h3', null, 'Geometry'), renderGeometry(result.metrics));
  if (!result.alignment.isIdentity) out.push(renderAlignment(result));
  if ((result.parts ?? []).length > 0) out.push(renderParts(result));
  return out;
}

/** "100 × 60 × 10 mm", or bare numbers when the unit is unknown. */
export function fmtSize(size: readonly number[], unit: MetricUnit | undefined): string {
  const magnitude = Math.max(...size.map(Math.abs));
  const parts = size.map((v) => formatMeasure(v, 1, unit, magnitude));
  return unit ? `${parts.map((p) => p.split(' ')[0]).join(' × ')} ${parts[0].split(' ')[1]}` : parts.join(' × ');
}

const volumeOf = (m: IMeshMetrics, unit: MetricUnit | undefined) => (m.volume !== null ? formatMeasure(m.volume, 3, unit) : '—');

/** Size, volume and surface of both versions and their change (or of one model). */
export function renderGeometry(cmp: IMetricsComparison): HTMLElement {
  const unit = displayUnit(cmp);
  const change = (text: string) => h('td', { class: text === 'no change' || text === '' ? 'num muted' : 'num changed' }, text);
  const sizeChange = (['x', 'y', 'z'] as const)
    .map((axis, i) => (cmp.size[i].delta !== 0 ? `${axis} ${formatChange(cmp.size[i], 1, unit).replace(/ \(.*\)$/, '')}` : ''))
    .filter(Boolean)
    .join(', ');
  const rows: [string, string, string, string, string?][] = [
    ['Size', fmtSize(cmp.base.size, unit), fmtSize(cmp.target.size, unit), sizeChange || 'no change'],
    ['Volume', volumeOf(cmp.base, unit), volumeOf(cmp.target, unit), cmp.volume ? formatChange(cmp.volume, 3, unit) : '', 'Enclosed volume; only for closed surfaces'],
    ['Surface', formatMeasure(cmp.surfaceArea.base, 2, unit), formatMeasure(cmp.surfaceArea.target, 2, unit), formatChange(cmp.surfaceArea, 2, unit)],
  ];
  if (cmp.base.parts > 1 || cmp.target.parts > 1) rows.push(['Pieces', String(cmp.base.parts), String(cmp.target.parts), cmp.base.parts === cmp.target.parts ? 'no change' : `${cmp.target.parts > cmp.base.parts ? '+' : '−'}${Math.abs(cmp.target.parts - cmp.base.parts)}`]);
  const notes = [
    ...[['Base', cmp.base] as const, ['Target', cmp.target] as const].flatMap(([side, m]) => {
      const n = volumeNote(m);
      return n ? [`${side}: ${n}.`] : [];
    }),
    cmp.unitsDiffer ? `The files state different units (${cmp.base.unit}, ${cmp.target.unit}); each number is in its own.` : !unit ? 'In the files’ own units: STL, OBJ and PLY do not state one.' : '',
  ].filter(Boolean);
  return h(
    'div',
    { class: 'geometry' },
    h(
      'table',
      { class: 'metrics' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Base'), h('th', null, 'Target'), h('th', null, 'Change'))),
      h(
        'tbody',
        null,
        rows.map(([label, b, t, c, hint]) => h('tr', { title: hint ?? '' }, h('th', null, label), h('td', { class: 'num' }, b), h('td', { class: 'num' }, t), change(c))),
      ),
    ),
    notes.length > 0 ? h('ul', { class: 'notes' }, notes.map((n) => h('li', null, n))) : null,
  );
}

/** Size, volume and surface of one model (before the second one is loaded). */
export function renderSingleGeometry(m: IMeshMetrics, label: string): HTMLElement {
  const unit = m.unit;
  const note = volumeNote(m);
  return h(
    'div',
    { class: 'geometry' },
    kv([
      [`${label} size`, fmtSize(m.size, unit)],
      ['Volume', volumeOf(m, unit)],
      ['Surface', formatMeasure(m.surfaceArea, 2, unit)],
      ...(m.parts > 1 ? ([['Pieces', String(m.parts)]] as [string, string][]) : []),
    ]),
    note || !unit ? h('ul', { class: 'notes' }, note ? h('li', null, `${note}.`) : null, !unit ? h('li', null, 'In the file’s own units.') : null) : null,
  );
}

/** "Tier 2 · topological (...)" → "topological (...)" when the prefix repeats the tier number. */
export function stripTierPrefix(name: string, tier: number): string {
  const m = /^\s*tier\s*(\d)\s*[·:\-–—]\s*/i.exec(name);
  return m && Number(m[1]) === tier ? name.slice(m[0].length) : name;
}

export function describeAlignment(matrix: ArrayLike<number>): { translation: Vec3; angleDeg: number; axis: Vec3; scale: Vec3 } {
  const m = new THREE.Matrix4().fromArray(Array.from(matrix));
  const t = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  m.decompose(t, q, sc);
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const angle = 2 * Math.acos(Math.min(1, q.w));
  const sinHalf = Math.sqrt(Math.max(0, 1 - q.w * q.w));
  const axis: Vec3 = sinHalf > 1e-9 ? [q.x / sinHalf, q.y / sinHalf, q.z / sinHalf] : [0, 0, 1];
  const scale = Math.max(1, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z));
  return {
    translation: cleanVec([t.x, t.y, t.z], 1e-6 * scale),
    angleDeg: THREE.MathUtils.radToDeg(angle),
    axis: cleanVec(axis, 1e-6),
    scale: [sc.x, sc.y, sc.z],
  };
}

/** Zero out components below `eps` (float32 storage noise reads better as 0 in the panel). */
function cleanVec(v: Vec3, eps: number): Vec3 {
  return v.map((c) => (Math.abs(c) < eps ? 0 : c)) as Vec3;
}

function renderAlignment(result: IDiffResult): HTMLElement {
  const al = result.alignment;
  const a = describeAlignment(al.matrix);
  const rows: [string, string][] = [];
  if (al.units) {
    rows.push(['Units', `${al.units.from} → ${al.units.to} (×${fmtNum(al.units.factor, 6)})`]);
  } else if ((al.scale ?? 1) !== 1) {
    rows.push(['Uniform scale', `×${fmtNum(al.scale, 6)}`]);
  }
  rows.push(
    ['Translation', fmtVec(a.translation)],
    ['Rotation', `${fmtNum(a.angleDeg, 4)}° about ${fmtVec(a.axis, 3)}`],
    ['RMS error', fmtNum(al.rmsError)],
  );
  if (result.tier === 3) rows.push(['ICP iterations', String(al.iterations)]);
  const title = result.tier === 3 ? 'Alignment (base → target)' : 'Global transform (whole model)';
  return h('div', { class: 'alignment' }, h('h3', null, title), kv(rows));
}

/** Parts that moved rigidly on their own. */
function renderParts(result: IDiffResult): HTMLElement {
  return h(
    'div',
    { class: 'alignment parts' },
    h('h3', null, `Moved parts (${result.parts.length})`),
    h(
      'ul',
      { class: 'part-list' },
      result.parts.map((p) =>
        h(
          'li',
          { title: p.source === 'registration' ? 'Re-matched by rigid registration (would otherwise read as removed + added)' : 'Already matched; one rigid motion explains it' },
          swatch(DIFF_CSS.modified),
          `${p.baseName ?? p.targetName ?? `${p.baseVertices.length}-vertex part`}: `,
          `${fmtNum(p.rotationDeg, 3)}°, shift ${fmtVec(cleanVec(p.centroidShift, 1e-6 * Math.max(1, ...p.centroidShift.map(Math.abs))))}`,
          p.deformedVertices > 0 ? ` · ${p.deformedVertices} edited` : '',
        ),
      ),
    ),
  );
}

export function renderAttempts(attempts: ITierAttempt[]): HTMLElement {
  return h(
    'ol',
    { class: 'attempts' },
    attempts.map((a) =>
      h(
        'li',
        { class: a.accepted ? 'accepted' : 'rejected' },
        h(
          'div',
          { class: 'attempt-head' },
          h('span', { class: 'attempt-tier' }, `Tier ${a.tier}`),
          h('span', { class: 'attempt-verdict' }, a.accepted ? 'ACCEPTED' : 'REJECTED'),
          h('span', { class: 'attempt-score' }, `${fmtNum(a.score, 3)} vs ${fmtNum(a.threshold, 3)}`),
          h('span', { class: 'attempt-ms' }, fmtMs(a.durationMs)),
        ),
        h('div', { class: 'attempt-reason' }, a.reason),
        Object.keys(a.metrics ?? {}).length > 0
          ? h(
              'div',
              { class: 'attempt-metrics' },
              Object.entries(a.metrics).map(([k, v]) => h('span', null, `${k}=${fmtNum(v, 3)}`)),
            )
          : null,
      ),
    ),
  );
}

export function renderMeshes(base: ILoadedMesh | null, target: ILoadedMesh | null): HTMLElement[] {
  const col = (m: ILoadedMesh | null, f: (x: ILoadedMesh) => string) => {
    const text = m ? f(m) : '—';
    return h('td', { class: 'num', title: text }, text);
  };
  const size = (mesh: IMesh) => {
    const b = mesh.metadata.bounds;
    return fmtVec([b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], 3);
  };
  const rows: [string, (x: ILoadedMesh) => string][] = [
    ['File', (x) => x.name],
    ['Loaded from', (x) => fmtSource(x.origin, location.host) ?? '—'],
    ['Format', (x) => x.mesh.metadata.format.toUpperCase()],
    ['Vertices', (x) => fmtInt(x.mesh.vertexCount)],
    ['Faces', (x) => fmtInt(x.mesh.faceCount)],
    ['Loader verts', (x) => fmtInt(x.mesh.metadata.sourceVertexCount)],
    ['Degenerate dropped', (x) => fmtInt(x.mesh.metadata.degenerateFacesDropped)],
    ['Groups', (x) => fmtInt(x.mesh.groups.length)],
    ['Size', (x) => size(x.mesh)],
    ['Bytes', (x) => (x.bytes > 0 ? fmtBytes(x.bytes) : '—')],
  ];
  // STEP: how finely OpenCascade tessellated it (both versions should match).
  if ([base, target].some((m) => m && stepInfo(m.mesh))) {
    rows.splice(3, 0, ['Tessellation', (x) => (stepInfo(x.mesh) ? `${stepInfo(x.mesh)!.deflection} mm` : '—')]);
  }
  const out: HTMLElement[] = [
    h(
      'table',
      { class: 'meshes' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Base'), h('th', null, 'Target'))),
      h(
        'tbody',
        null,
        rows.map(([label, f]) => h('tr', null, h('th', null, label), col(base, f), col(target, f))),
      ),
    ),
  ];
  const warnings = [
    ...(base?.mesh.metadata.warnings ?? []).map((w) => `Base: ${w}`),
    ...(target?.mesh.metadata.warnings ?? []).map((w) => `Target: ${w}`),
  ];
  if (warnings.length > 0) {
    out.push(h('ul', { class: 'warnings' }, warnings.map((w) => h('li', null, w))));
  }
  return out;
}

export interface IInspectorModel {
  side: 'base' | 'target';
  index: number;
  change: IVertexChange | null;
  hit: IPickHit | null;
  result: IDiffResult | null;
  base: IMesh | null;
  target: IMesh | null;
  /** Position of the vertex in its own mesh space (preview / raw base). */
  rawPosition: Vec3 | null;
}

export interface IInspectorActions {
  inspect(side: 'base' | 'target', index: number): void;
  focus(point: Vec3): void;
  close(): void;
}

export function renderInspector(m: IInspectorModel, actions: IInspectorActions): HTMLElement {
  const c = m.change;
  const link = (side: 'base' | 'target', index: number) =>
    index >= 0
      ? h(
          'button',
          { class: 'link', title: `Inspect ${side} vertex #${index}`, onclick: () => actions.inspect(side, index) },
          `${side} #${index}`,
        )
      : h('span', { class: 'muted' }, `${side} —`);

  const body: (HTMLElement | null)[] = [];
  if (c) {
    const color = VERTEX_STATUS_COLOR[c.status] ?? DIFF_CSS.unchanged;
    body.push(
      h('div', { class: 'insp-status' }, swatch(color), h('strong', null, VERTEX_STATUS_LABEL[c.status] ?? `status ${c.status}`)),
      h('div', { class: 'insp-map' }, link('base', c.baseIndex), h('span', { class: 'arrow' }, '→'), link('target', c.targetIndex)),
    );
    const rows: [string, string][] = [
      ['from', c.from ? fmtVec(c.from, 5) : '— (added)'],
      ['to', c.to ? fmtVec(c.to, 5) : '— (removed)'],
      ['Δ', c.delta ? fmtVec(c.delta, 4) : '—'],
      ['distance', fmtNum(c.distance, 5)],
    ];
    if (m.result && !m.result.alignment.isIdentity && c.baseIndex >= 0 && m.base) {
      const p = m.base.positions;
      const i = c.baseIndex * 3;
      rows.splice(1, 0, ['base (raw)', fmtVec([p[i], p[i + 1], p[i + 2]], 5)]);
    }
    const idB = c.baseIndex >= 0 ? m.base?.vertexIds?.[c.baseIndex] : null;
    const idT = c.targetIndex >= 0 ? m.target?.vertexIds?.[c.targetIndex] : null;
    if (idB || idT) rows.push(['vertex id', `${idB ?? '—'} → ${idT ?? '—'}`]);
    body.push(kv(rows));
    if (m.result?.tier === 3) {
      body.push(h('p', { class: 'note' }, 'Tier 3: nearest-surface mapping in aligned space (may be many-to-one).'));
    }
  } else if (m.rawPosition) {
    body.push(
      h('div', { class: 'insp-map' }, `${m.side} #${m.index}`),
      kv([['position', fmtVec(m.rawPosition, 5)]]),
      h('p', { class: 'note' }, 'Load both models to see the correspondence.'),
    );
  }
  if (m.hit) {
    const status = m.hit.faceStatus;
    body.push(
      h(
        'div',
        { class: 'insp-face' },
        status != null ? swatch(FACE_STATUS_COLOR[status] ?? DIFF_CSS.unchanged) : null,
        `picked ${m.hit.side} face #${m.hit.face}`,
        status != null ? ` · ${FACE_STATUS_LABEL[status] ?? status}` : '',
        m.hit.layer === 'ghost' ? ' · (ghost)' : '',
      ),
    );
  }
  const focusPoint = c ? (c.to ?? c.from) : m.rawPosition;
  return h(
    'div',
    { class: 'inspector-card' },
    h(
      'div',
      { class: 'insp-head' },
      h('span', null, 'Vertex inspector'),
      h('button', { class: 'icon', title: 'Clear selection (Esc)', onclick: () => actions.close() }, '×'),
    ),
    body,
    focusPoint ? h('button', { class: 'small', onclick: () => actions.focus(focusPoint) }, 'Orbit around this vertex') : null,
  );
}

export function kv(rows: [string, string][]): HTMLElement {
  return h(
    'dl',
    { class: 'kv' },
    rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
  );
}
