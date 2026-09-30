/**
 * Merge review (`?mode=merge`): load base / ours / theirs, run the three-way merge in the engine
 * worker and show the merged model coloured by who shaped each face (MERGE_COLORS). Conflict
 * regions are orange until resolved. Click a region (or its card) to select it: its versions
 * appear as ghosts (ours blue, theirs purple, base grey), and Ours / Theirs / Base — buttons or
 * keys 1 / 2 / 3 — resolve it. The result downloads as STL / OBJ / GLB / glTF, and the equivalent CLI command
 * reproduces it. Opened by `polymerge review <path>`, it can also save the result to <path> and
 * stage it ("Save to repository"; the server side and its checks: docs/write-back-security.md).
 */
import {
  MERGE_COLORS,
  MeshLoadError,
  WRITABLE_FORMATS,
  writeMesh,
  type IMergeConflict,
  type MergeResolution,
  type SourceFormat,
  type Vec3,
  type WritableFormat,
} from 'polymerge-core';
import * as THREE from 'three';
import { findMergeDemo, MERGE_DEMOS } from './dev/merge-demos.js';
import { h, nextFrame, setChildren, swatch } from './dom.js';
import { DiffEngine } from './engine.js';
import { fmtInt, fmtMs } from './format.js';
import { publish, type IMergeHookState, type IPolymergeHook } from './hook.js';
import { conflictGhosts, faceConflicts, mergeFaceKinds, sideToMerged, type MergeFaceKind } from './scene/merge-layers.js';
import { DiffViewer, type IMergeLayerVisibility } from './scene/viewer.js';
import { ACCEPTED_EXTENSIONS, SourceError, loadFromFile, loadFromUrl, type ILoadedMesh } from './sources.js';
import type { IMergeView } from './worker/protocol.js';

type MergeSide = 'base' | 'ours' | 'theirs';
const SIDES: MergeSide[] = ['base', 'ours', 'theirs'];
const SIDE_LABEL: Record<MergeSide, string> = { base: 'Base (common ancestor)', ours: 'Ours', theirs: 'Theirs' };
const RESOLUTIONS: MergeResolution[] = ['ours', 'theirs', 'base'];
const RESOLUTION_COLOR: Record<MergeResolution, string> = { ours: MERGE_COLORS.ours, theirs: MERGE_COLORS.theirs, base: MERGE_COLORS.unchanged };

/** What `polymerge review` says this session can save (GET /api/review/session). */
interface IReviewSessionInfo {
  path: string;
  name: string;
  format?: string;
  writable: boolean;
  reason?: string;
}

/** "Save to repository": where the last attempt got to. `picks` = the choices it saved. */
interface ISaveState {
  state: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
  written?: boolean;
  picks?: string;
}

const TOKEN_HEADER = 'x-polymerge-token';
const TOKEN_STORAGE = 'polymerge-review-token';

/**
 * The review session's token: from the URL fragment (`#token=…`, put there by `polymerge
 * review`), which is then removed from the address bar at once, or — after a reload of this tab
 * — from sessionStorage (per tab and origin). Never in the query, a cookie or localStorage.
 */
function takeSessionToken(): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(location.hash);
  if (m) {
    const url = new URL(location.href);
    url.hash = '';
    history.replaceState(history.state, '', url);
    try {
      sessionStorage.setItem(TOKEN_STORAGE, m[1]);
    } catch {
      // storage unavailable: the token lives in memory only (a reload loses the Save button)
    }
    return m[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_STORAGE);
  } catch {
    return null;
  }
}

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

const LAYER_DEFS: { key: keyof IMergeLayerVisibility; label: string; color?: string; hint: string }[] = [
  { key: 'previewOurs', label: 'Preview: ours', color: MERGE_COLORS.ours, hint: "The selected conflict region as ours has it" },
  { key: 'previewTheirs', label: 'Preview: theirs', color: MERGE_COLORS.theirs, hint: 'The selected conflict region as theirs has it' },
  { key: 'previewBase', label: 'Preview: base', color: MERGE_COLORS.unchanged, hint: 'The selected conflict region as it was in the base' },
  { key: 'unchanged', label: 'Show unchanged faces', color: MERGE_COLORS.unchanged, hint: 'Faces neither side changed' },
  { key: 'baseGhost', label: 'Base ghost', color: MERGE_COLORS.unchanged, hint: 'The whole base model, translucent' },
  { key: 'wireframe', label: 'Wireframe overlay', hint: 'Triangle edges' },
];

export class MergeApp {
  private readonly viewer: DiffViewer;
  private readonly engine = new DiffEngine(new URLSearchParams(location.search).get('worker') !== '0');
  private models: Partial<Record<MergeSide, ILoadedMesh>> = {};
  private view: IMergeView | null = null;
  private conflictOf: Int32Array = new Int32Array(0);
  private kinds: MergeFaceKind[] = [];
  private resolutions: Record<number, MergeResolution> = {};
  private selected: number | null = null;
  private source = '';
  /** Path of the model in its repository (from `polymerge view`), for the resolve command. */
  private repoPath: string | null = null;
  /** Set when `polymerge review` offers saving: its token and what it can save. */
  private saveSession: { token: string; info: IReviewSessionInfo } | null = null;
  private saveState: ISaveState = { state: 'idle' };
  /** Other models were loaded: this tab no longer shows the review session's merge. */
  private saveEnded = false;
  /** The reviewer confirmed saving despite collision warnings (reset by every new choice). */
  private warningsAcknowledged = false;
  private seq = 0;
  private log: string[] = [];

  private readonly el = {
    drops: {} as Record<MergeSide, { root: HTMLElement; file: HTMLElement }>,
    examples: h('select', { id: 'merge-examples', 'aria-label': 'Merge examples' }),
    exampleInfo: h('p', { class: 'example-info muted' }),
    rerun: h('button', { id: 'rerun-merge', disabled: true }, 'Re-run merge'),
    reset: h('button', { id: 'reset-view' }, 'Reset view'),
    summary: h('div', { class: 'summary' }),
    conflicts: h('div', { class: 'conflicts' }),
    bulk: h('div', { class: 'row bulk hidden' }),
    warnings: h('div', { class: 'merge-warnings' }),
    output: h('div', { class: 'merge-output' }),
    layers: h('div', { class: 'layers' }),
    engineLog: h('pre', { class: 'engine-log' }),
    overlay: h('div', { class: 'loading hidden' }),
    overlayMsg: h('div', { class: 'loading-msg' }),
    busy: h('div', { class: 'hud-busy hidden' }, 'Resolving…'),
    error: h('div', { class: 'error-banner hidden', role: 'alert' }),
    empty: h('div', { class: 'empty-hint' }),
    hudStatus: h('div', { class: 'hud-tier hidden' }),
    viewport: h('div', { class: 'viewport' }),
  };

  constructor(root: HTMLElement) {
    this.buildLayout(root);
    this.viewer = new DiffViewer(this.el.viewport);
    this.viewer.onPick = (hit) => {
      const id = hit && hit.layer === 'merged' ? this.conflictOf[hit.face] : -1;
      this.select(id >= 0 ? id : null, false);
    };
    this.renderLayers();
    this.renderAll();
    this.publishState('idle');
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  private buildLayout(root: HTMLElement): void {
    const el = this.el;
    const drop = (side: MergeSide): HTMLElement => {
      const input = h('input', { type: 'file', accept: ACCEPTED_EXTENSIONS.join(','), class: 'hidden-input', 'aria-label': SIDE_LABEL[side] });
      const file = h('span', { class: 'drop-file' }, 'Drop a model or click to browse');
      const rootEl = h('label', { class: 'drop', dataset: { side } }, input, h('span', { class: 'drop-title' }, SIDE_LABEL[side]), file);
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        input.value = '';
        if (f) void this.loadFiles([[side, f]]);
      });
      rootEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rootEl.classList.add('over');
      });
      rootEl.addEventListener('dragleave', () => rootEl.classList.remove('over'));
      rootEl.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rootEl.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) void this.loadFiles([[side, f]]);
      });
      el.drops[side] = { root: rootEl, file };
      return rootEl;
    };

    el.examples.append(
      h('option', { value: '' }, 'Merge examples…'),
      ...MERGE_DEMOS.map((d) => h('option', { value: d.id }, d.title)),
    );
    el.examples.addEventListener('change', () => {
      const id = el.examples.value;
      if (id) void this.loadDemo(id);
    });
    el.rerun.addEventListener('click', () => void this.runMerge());
    el.reset.addEventListener('click', () => this.viewer.resetView());
    el.overlay.append(h('div', { class: 'spinner' }), el.overlayMsg);

    const legend = h(
      'div',
      { class: 'hud-legend' },
      ([
        [MERGE_COLORS.unchanged, 'Unchanged'],
        [MERGE_COLORS.ours, 'From ours'],
        [MERGE_COLORS.theirs, 'From theirs'],
        [MERGE_COLORS.both, 'Same on both'],
        [MERGE_COLORS.conflict, 'Conflict'],
      ] as const).map(([c, l]) => h('span', null, swatch(c), l)),
    );

    const panel = h(
      'aside',
      { class: 'panel' },
      h(
        'header',
        { class: 'brand' },
        h('span', { class: 'logo' }, 'polymerge'),
        h('span', { class: 'tagline' }, 'merge review'),
        h('a', { class: 'mode-link', href: '?', title: 'Compare two versions' }, '← Diff'),
      ),
      h(
        'section',
        { class: 'sec' },
        h('h2', null, 'Models'),
        h('div', { class: 'drops drops-3' }, SIDES.map(drop)),
        h('div', { class: 'row' }, el.examples),
        el.exampleInfo,
        h('div', { class: 'row buttons' }, el.rerun, el.reset),
      ),
      h('section', { class: 'sec' }, h('h2', null, 'Merge'), el.summary),
      h('section', { class: 'sec' }, h('h2', null, 'Conflicts'), el.conflicts, el.bulk, el.warnings),
      h('section', { class: 'sec' }, h('h2', null, 'Result'), el.output),
      h('section', { class: 'sec' }, h('h2', null, 'Layers'), el.layers),
      h('section', { class: 'sec' }, h('details', null, h('summary', null, 'Engine log'), el.engineLog)),
    );

    const stage = h(
      'main',
      { class: 'stage merge-stage' },
      el.viewport,
      el.hudStatus,
      legend,
      h('div', { class: 'hud-hint' }, 'click an orange region to select it · 1 / 2 / 3 = ours / theirs / base · 0 = undo · n / p = next / previous'),
      el.busy,
      el.empty,
      el.error,
      el.overlay,
    );
    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      stage.classList.add('over');
    });
    stage.addEventListener('dragleave', (e) => {
      if (e.target === stage || !stage.contains(e.relatedTarget as Node)) stage.classList.remove('over');
    });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('over');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length >= 3) void this.loadFiles(SIDES.map((s, i) => [s, files[i]] as [MergeSide, File]));
      else if (files.length > 0) {
        const free = SIDES.filter((s) => !this.models[s]);
        void this.loadFiles(files.slice(0, free.length || 1).map((f, i) => [free[i] ?? 'base', f] as [MergeSide, File]));
      }
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    root.append(h('div', { class: 'app' }, panel, stage));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') this.select(null, false);
    else if (k === 'n' || k === 'p') this.step(k === 'n' ? 1 : -1);
    else if (this.selected !== null) {
      const choice: Record<string, MergeResolution | null> = { '1': 'ours', o: 'ours', '2': 'theirs', t: 'theirs', '3': 'base', b: 'base', '0': null, u: null };
      if (k in choice) void this.resolve(this.selected, choice[k]);
    }
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async start(params: URLSearchParams): Promise<void> {
    const demo = params.get('demo');
    const token = takeSessionToken();
    this.repoPath = params.get('path');
    if (demo) return this.loadDemo(demo);
    const urls = SIDES.map((s) => params.get(s));
    if (urls.every(Boolean)) {
      if (token) void this.openSaveSession(token);
      return this.loadTriple(
        Object.fromEntries(SIDES.map((s, i) => [s, () => loadFromUrl(urls[i]!, params.get(`${s}Name`) ?? undefined)])) as Record<
          MergeSide,
          () => Promise<ILoadedMesh>
        >,
        'url',
      );
    }
  }

  /**
   * Ask the server what this review session can save. Anything but a clear answer (a `view` or
   * `demo` server has no such route, a stale token is refused) leaves saving off.
   */
  private async openSaveSession(token: string): Promise<void> {
    try {
      const res = await fetch('/api/review/session', { headers: { [TOKEN_HEADER]: token }, cache: 'no-store', credentials: 'omit' });
      if (!res.ok) return;
      const info = (await res.json()) as IReviewSessionInfo;
      if (typeof info?.path !== 'string' || this.saveEnded) return;
      this.saveSession = { token, info };
      // Still loading: show() renders it with the merge.
      if (this.view) {
        this.renderOutput();
        this.publishState('ready');
      }
    } catch {
      // not a review session: no saving
    }
  }

  /** The viewer now shows other models than the review session's: saving them is not offered. */
  private endSaveSession(): void {
    this.saveEnded = true;
    this.saveSession = null;
    this.saveState = { state: 'idle' };
    this.repoPath = null;
  }

  private async loadDemo(id: string): Promise<void> {
    const demo = findMergeDemo(id);
    if (!demo) {
      this.fail('Unknown example', new Error(`no merge example "${id}" (known: ${MERGE_DEMOS.map((d) => d.id).join(', ')})`));
      return;
    }
    this.endSaveSession();
    this.el.examples.value = id;
    setChildren(this.el.exampleInfo, h('span', { class: 'desc expanded' }, demo.description));
    this.setUrl({ mode: 'merge', demo: id });
    const triple = demo.build();
    const loaded = (side: MergeSide): (() => Promise<ILoadedMesh>) => async () => ({
      mesh: triple[side],
      name: triple[side].metadata.sourceName ?? side,
      bytes: 0,
      origin: 'example',
    });
    await this.loadTriple({ base: loaded('base'), ours: loaded('ours'), theirs: loaded('theirs') }, `demo:${id}`);
  }

  private async loadFiles(entries: [MergeSide, File][]): Promise<void> {
    this.endSaveSession();
    this.el.examples.value = '';
    this.el.exampleInfo.replaceChildren();
    this.setUrl({ mode: 'merge' });
    const seq = ++this.seq;
    this.setLoading('Loading models…');
    const settled = await Promise.allSettled(entries.map(([side, file]) => this.loadOne(side, () => loadFromFile(file))));
    if (seq !== this.seq) return;
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    this.source = 'files';
    if (failed) return this.fail('Could not load model', failed.reason);
    if (SIDES.every((s) => this.models[s])) return this.runMerge(seq);
    this.hideLoading();
    this.renderAll();
    this.publishState('idle');
  }

  private async loadTriple(loaders: Record<MergeSide, () => Promise<ILoadedMesh>>, source: string): Promise<void> {
    const seq = ++this.seq;
    this.setLoading('Loading models…');
    this.models = {};
    this.resolutions = {};
    this.selected = null;
    const settled = await Promise.allSettled(SIDES.map((s) => this.loadOne(s, loaders[s])));
    if (seq !== this.seq) return;
    this.source = source;
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) return this.fail('Could not load models', failed.reason);
    await this.runMerge(seq);
  }

  private async loadOne(side: MergeSide, loader: () => Promise<ILoadedMesh>): Promise<void> {
    this.markDrop(side, 'loading');
    try {
      this.models[side] = await loader();
      this.markDrop(side, 'ok');
    } catch (err) {
      this.models[side] = undefined;
      this.markDrop(side, 'error', errorMessage(err));
      throw new Error(`${SIDE_LABEL[side]}: ${errorMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Merge and resolution
  // -------------------------------------------------------------------------

  private async runMerge(seq = ++this.seq): Promise<void> {
    const { base, ours, theirs } = this.models;
    if (!base || !ours || !theirs) return;
    this.setLoading('Merging…');
    await nextFrame();
    if (seq !== this.seq) return;
    this.resolutions = {};
    this.selected = null;
    this.log = [];
    let view: IMergeView;
    try {
      view = await this.engine.merge(base.mesh, ours.mesh, theirs.mesh, {}, this.onLog(seq));
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (seq === this.seq) this.fail('Merge failed', err);
      return;
    }
    if (seq !== this.seq) return;
    await this.show(view, true);
  }

  private onLog(seq: number) {
    return (level: 'info' | 'warn' | 'debug', m: string): void => {
      if (level === 'debug') return;
      this.log.push(level === 'warn' ? `WARN ${m}` : m);
      if (level === 'info' && seq === this.seq) this.el.overlayMsg.textContent = m.replace(/^\[polymerge\]\s*/, '');
    };
  }

  /** Resolve one conflict (null = back to unresolved) and re-materialise the merge. */
  async resolve(id: number, choice: MergeResolution | null): Promise<void> {
    if (!this.view) return;
    const next = { ...this.resolutions };
    if (choice) next[id] = choice;
    else delete next[id];
    await this.applyResolutions(next);
  }

  private async resolveAll(choice: MergeResolution | null): Promise<void> {
    if (!this.view) return;
    const next: Record<number, MergeResolution> = {};
    if (choice) for (const c of this.view.conflicts) next[c.id] = choice;
    await this.applyResolutions(next);
  }

  private async applyResolutions(next: Record<number, MergeResolution>): Promise<void> {
    const seq = ++this.seq;
    this.resolutions = next;
    // A confirmation covers the result it was given for, not the next one.
    this.warningsAcknowledged = false;
    this.el.busy.classList.remove('hidden');
    this.publishState('loading');
    let view: IMergeView;
    try {
      view = await this.engine.resolve(next, this.onLog(seq));
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (seq === this.seq) this.fail('Resolving failed', err);
      return;
    } finally {
      if (seq === this.seq) this.el.busy.classList.add('hidden');
    }
    if (seq !== this.seq) return;
    await this.show(view, false);
  }

  private async show(view: IMergeView, refit: boolean): Promise<void> {
    const base = this.models.base!.mesh;
    this.view = view;
    this.conflictOf = faceConflicts(view);
    this.kinds = mergeFaceKinds(view, this.conflictOf);
    this.viewer.showMerge(view.merged, this.kinds, base, sideToMerged(view.frame.transform.matrix, null), { refit });
    if (this.selected !== null && !view.conflicts.some((c) => c.id === this.selected)) this.selected = null;
    // Start on the first unresolved conflict, so a reviewer can go straight to the choices.
    if (refit && this.selected === null) this.selected = view.conflicts.find((c) => !c.wholeModel)?.id ?? null;
    this.applySelection();
    this.renderAll();
    await this.viewer.whenRendered();
    this.hideLoading();
    this.hideError();
    this.publishState('ready');
  }

  /** Select a conflict (null = none): highlight its region, show its versions, scroll to its card. */
  select(id: number | null, focus: boolean): void {
    this.selected = id;
    this.applySelection();
    // Only the highlight changes: re-rendering the cards would replace the button being clicked.
    for (const card of this.el.conflicts.querySelectorAll<HTMLElement>('[data-conflict]')) {
      card.classList.toggle('selected', card.dataset.conflict === String(id));
    }
    if (id !== null) {
      this.el.conflicts.querySelector(`[data-conflict="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      const c = this.view?.conflicts.find((x) => x.id === id);
      if (c && focus) this.viewer.focus(c.focus);
    }
    this.publishState(this.view ? 'ready' : 'idle');
  }

  private step(dir: 1 | -1): void {
    const list = this.view?.conflicts.filter((c) => !c.wholeModel) ?? [];
    if (list.length === 0) return;
    const at = list.findIndex((c) => c.id === this.selected);
    const next = list[(at + dir + list.length) % list.length] ?? list[0];
    this.select(next.id, true);
  }

  private applySelection(): void {
    this.viewer.setMergeGhostEmphasis(null);
    const view = this.view;
    const c = view && this.selected !== null ? view.conflicts.find((x) => x.id === this.selected) : undefined;
    if (!view || !c || c.wholeModel) {
      this.viewer.setMergeHighlight(null, null);
      this.viewer.setMergeGhosts(null);
      return;
    }
    const faces: number[] = [];
    for (let f = 0; f < this.conflictOf.length; f++) if (this.conflictOf[f] === c.id) faces.push(f);
    this.viewer.setMergeHighlight(view.merged, faces);
    const meshes = { base: this.models.base!.mesh, ours: this.models.ours!.mesh, theirs: this.models.theirs!.mesh };
    this.viewer.setMergeGhosts(conflictGhosts(c, view, meshes, this.viewer.sceneOrigin));
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  private renderAll(): void {
    this.renderSummary();
    this.renderConflicts();
    this.renderOutput();
    this.renderEmpty();
    this.el.rerun.disabled = !SIDES.every((s) => this.models[s]);
    this.el.engineLog.textContent = this.log.length > 0 ? this.log.join('\n') : '(no engine output)';
    const names = SIDES.map((s) => this.models[s]?.name).filter(Boolean);
    document.title = names.length > 0 ? `merge ${names.join(' · ')} · polymerge` : 'polymerge merge';
  }

  private renderSummary(): void {
    const v = this.view;
    if (!v) {
      setChildren(this.el.summary, h('p', { class: 'muted' }, 'Load the common ancestor (base) and the two edited versions (ours, theirs).'));
      this.el.hudStatus.classList.add('hidden');
      return;
    }
    const s = v.stats;
    const unresolved = v.conflicts.filter((c) => c.resolution === null).length;
    const status = v.conflicts.length === 0 ? 'Clean merge' : unresolved === 0 ? 'All conflicts resolved' : `${unresolved} of ${v.conflicts.length} conflict(s) unresolved`;
    const row = (color: string, label: string, text: string): HTMLElement => h('tr', null, h('td', null, swatch(color), label), h('td', null, text));
    const changes = (moved: number, deleted: number, faces: number, parts: number): string =>
      [moved && `${fmtInt(moved)} moved`, deleted && `${fmtInt(deleted)} deleted`, faces && `${fmtInt(faces)} new faces`, parts && `${parts} part motion(s)`]
        .filter(Boolean)
        .join(' · ') || 'nothing';
    setChildren(
      this.el.summary,
      h('div', { class: `merge-status ${unresolved > 0 ? 'bad' : 'ok'}`, dataset: { unresolved: String(unresolved) } }, status),
      h(
        'table',
        { class: 'merge-applied' },
        h(
          'tbody',
          null,
          row(MERGE_COLORS.ours, 'Ours', changes(s.movedFromOurs, s.deletedFromOurs, s.facesAddedFromOurs, s.partMotionsFromOurs)),
          row(MERGE_COLORS.theirs, 'Theirs', changes(s.movedFromTheirs, s.deletedFromTheirs, s.facesAddedFromTheirs, s.partMotionsFromTheirs)),
          row(MERGE_COLORS.both, 'Same on both', changes(s.movedConvergent, s.deletedConvergent, s.facesAddedConvergent, 0)),
        ),
      ),
      h(
        'p',
        { class: 'muted small' },
        `Ours matched by Tier ${v.ours.tier}, theirs by Tier ${v.theirs.tier} · frame ${v.frame.source} · `,
        `${fmtInt(v.merged.vertexCount)} vertices, ${fmtInt(v.merged.faceCount)} faces · ${fmtMs(v.durationMs)}`,
      ),
    );
    this.el.hudStatus.classList.remove('hidden');
    setChildren(this.el.hudStatus, h('strong', null, status));
  }

  private renderConflicts(): void {
    const v = this.view;
    this.el.bulk.classList.toggle('hidden', !v || v.conflicts.length < 2);
    if (!v) {
      setChildren(this.el.conflicts, h('p', { class: 'muted' }, 'No merge yet.'));
      this.el.warnings.replaceChildren();
      return;
    }
    if (v.conflicts.length === 0) {
      setChildren(this.el.conflicts, h('p', { class: 'muted' }, 'None — every change was merged automatically.'));
    } else {
      setChildren(
        this.el.conflicts,
        v.conflicts.map((c) => this.conflictCard(c)),
      );
    }
    setChildren(
      this.el.bulk,
      h('span', { class: 'muted small' }, 'All:'),
      RESOLUTIONS.map((r) => h('button', { class: 'small', dataset: { all: r }, onclick: () => void this.resolveAll(r) }, `All ${r}`)),
      h('button', { class: 'small', dataset: { all: 'clear' }, onclick: () => void this.resolveAll(null) }, 'Clear'),
    );
    setChildren(
      this.el.warnings,
      v.warnings.map((w) => h('div', { class: 'merge-warning', role: 'status' }, h('strong', null, 'Warning: '), w.message)),
    );
  }

  private conflictCard(c: IMergeConflict): HTMLElement {
    const selected = c.id === this.selected;
    const card = h(
      'div',
      { class: `conflict-card${selected ? ' selected' : ''}${c.resolution ? ' resolved' : ''}`, dataset: { conflict: String(c.id) } },
      h(
        'div',
        { class: 'conflict-head' },
        h('span', { class: 'conflict-id' }, `#${c.id}`),
        Object.keys(c.kinds).map((k) => h('span', { class: 'chip' }, k)),
        h('span', { class: 'conflict-state' }, c.resolution ? `→ ${c.resolution}` : 'unresolved'),
      ),
      h('div', { class: 'conflict-msg' }, c.message),
      h(
        'div',
        { class: 'conflict-actions' },
        RESOLUTIONS.map((r) =>
          h(
            'button',
            {
              class: `pick${c.resolution === r ? ' active' : ''}`,
              style: `--pick: ${RESOLUTION_COLOR[r]}`,
              dataset: { pick: r },
              title: `Take ${r === 'base' ? 'neither side (keep the base)' : `${r}’s version`} here`,
              onclick: (e: Event) => {
                e.stopPropagation();
                void this.resolve(c.id, c.resolution === r ? null : r);
              },
              // Hover = preview: show that version of the region, filled, in place.
              onmouseenter: () => {
                if (c.wholeModel) return;
                if (this.selected !== c.id) this.select(c.id, false);
                this.viewer.setMergeGhostEmphasis(r);
              },
              onmouseleave: () => this.viewer.setMergeGhostEmphasis(null),
            },
            r === 'base' ? 'Base' : r === 'ours' ? 'Ours' : 'Theirs',
          ),
        ),
        c.wholeModel
          ? null
          : h(
              'button',
              {
                class: 'small focus',
                title: 'Look at this region',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  this.select(c.id, true);
                },
              },
              'Focus',
            ),
      ),
    );
    card.addEventListener('click', () => this.select(c.id, false));
    return card;
  }

  private renderOutput(): void {
    const v = this.view;
    if (!v) {
      setChildren(this.el.output, h('p', { class: 'muted' }, 'The merged model can be downloaded once the merge has run.'));
      return;
    }
    const download = (format: WritableFormat): HTMLElement =>
      h('button', { class: 'small', dataset: { download: format }, onclick: () => this.download(format) }, `Download .${format}`);
    const command = this.command();
    const copy = h('button', { class: 'small', onclick: () => void navigator.clipboard?.writeText(command.join('\n')) }, 'Copy');
    setChildren(
      this.el.output,
      this.saveBlock(v),
      h(
        'p',
        { class: 'muted small' },
        v.clean ? 'Nothing is unresolved.' : 'Unresolved regions are written in their BASE state (as the CLI does).',
      ),
      h('div', { class: 'row buttons' }, ...WRITABLE_FORMATS.map(download)),
      h('p', { class: 'muted small' }, 'Same result from the command line:'),
      h('pre', { class: 'merge-command' }, command.join('\n')),
      h('div', { class: 'row' }, copy),
    );
  }

  /** Picks as a stable string, to tell whether the choices changed since a save. */
  private static picksKey(v: IMergeView): string {
    return v.conflicts.map((c) => `${c.id}=${c.resolution ?? '-'}`).join(' ');
  }

  /**
   * "Save to repository" (only in a `polymerge review` session that can save): enabled once every
   * conflict is resolved; collision warnings need an explicit "save anyway" first.
   */
  private saveBlock(v: IMergeView): HTMLElement | null {
    const session = this.saveSession;
    if (!session) return null;
    const { info } = session;
    const s = this.saveState;
    const block = h(
      'div',
      { class: 'save-repo', dataset: { saveState: s.state } },
      h('div', { class: 'save-title' }, 'Save to repository'),
      h('p', { class: 'muted small' }, `Writes `, h('code', null, info.path), ` and stages it (git add). Nothing is committed.`),
    );
    if (!info.writable) {
      block.append(h('p', { class: 'save-status bad' }, `Unavailable: ${info.reason ?? 'this session cannot save'}. Download the result or use the command below.`));
      return block;
    }
    if (s.state === 'saved') {
      block.append(
        h('p', { class: 'save-status ok', role: 'status' }, s.message ?? `Saved ${info.path}.`),
        h('p', { class: 'muted small' }, 'Next, conclude the merge:'),
        h('pre', { class: 'merge-command' }, 'git commit'),
      );
      if (s.picks !== MergeApp.picksKey(v)) {
        block.append(h('p', { class: 'save-status bad' }, 'Your choices changed after saving: the file in the repository still has the earlier ones.'));
      }
      return block;
    }
    const unresolved = v.conflicts.filter((c) => c.resolution === null).length;
    const warned = v.warnings.length > 0;
    const blocked =
      unresolved > 0
        ? `Resolve every conflict first (${unresolved} left): saving now would mark regions still at base as resolved.`
        : warned && !this.warningsAcknowledged
          ? 'Your choices combine into a collision (see the warning above). Confirm to save anyway.'
          : null;
    if (warned && unresolved === 0) {
      const ack = h('input', { type: 'checkbox', checked: this.warningsAcknowledged, dataset: { saveAck: '' } });
      ack.addEventListener('change', () => {
        this.warningsAcknowledged = ack.checked;
        this.renderOutput();
        this.publishState('ready');
      });
      block.append(h('label', { class: 'save-ack' }, ack, h('span', null, 'Save anyway: I have reviewed the collision warning.')));
    }
    const saving = s.state === 'saving';
    block.append(
      h('div', { class: 'row buttons' }, h('button', { class: 'save-button', dataset: { save: 'repo' }, disabled: blocked !== null || saving, onclick: () => void this.saveToRepository() }, saving ? 'Saving…' : 'Save to repository')),
    );
    if (s.state === 'error') block.append(h('p', { class: 'save-status bad', role: 'alert' }, s.written ? 'Saved, but not staged: ' : 'Not saved: ', s.message ?? 'unknown error'));
    else if (blocked) block.append(h('p', { class: 'muted small' }, blocked));
    return block;
  }

  /**
   * Save through `polymerge review`: send the choices (never bytes or a path) plus the SHA-256 of
   * the file this view would write; the server recomputes the file and writes it only if its own
   * result hashes the same.
   */
  private async saveToRepository(): Promise<void> {
    const session = this.saveSession;
    const v = this.view;
    if (!session || !v || !session.info.writable || !session.info.format || this.saveState.state === 'saving') return;
    const picks: Record<string, MergeResolution> = {};
    for (const c of v.conflicts) if (c.resolution) picks[c.id] = c.resolution;
    const key = MergeApp.picksKey(v);
    this.setSaveState({ state: 'saving' });
    try {
      const bytes = writeMesh(v.merged, session.info.format as SourceFormat, { name: session.info.name });
      const expect = hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      const res = await fetch('/api/review/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: session.token },
        body: JSON.stringify({ picks, acknowledgeWarnings: v.warnings.length > 0 && this.warningsAcknowledged, expect }),
        cache: 'no-store',
        credentials: 'omit',
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; written?: boolean; message?: string; error?: string } | null;
      if (res.ok && body?.ok) this.setSaveState({ state: 'saved', message: body.message, picks: key });
      else this.setSaveState({ state: 'error', written: body?.written === true, message: body?.message ?? body?.error ?? `HTTP ${res.status}` });
    } catch (err) {
      this.setSaveState({ state: 'error', message: errorMessage(err) });
    }
  }

  private setSaveState(next: ISaveState): void {
    this.saveState = next;
    this.renderOutput();
    this.publishState(this.view ? 'ready' : 'idle');
  }

  private renderLayers(): void {
    const layers = this.viewer.getMergeLayers();
    setChildren(
      this.el.layers,
      LAYER_DEFS.map((def) => {
        const input = h('input', { type: 'checkbox', checked: layers[def.key], dataset: { layer: def.key } });
        input.addEventListener('change', () => this.viewer.setMergeLayers({ [def.key]: input.checked }));
        return h(
          'label',
          { class: 'layer', title: def.hint },
          input,
          def.key === 'wireframe' ? h('span', { class: 'swatch wire' }) : swatch(def.color ?? MERGE_COLORS.unchanged),
          h('span', { class: 'layer-label' }, def.label),
        );
      }),
    );
  }

  private renderEmpty(): void {
    const show = !this.view && !SIDES.some((s) => this.models[s]);
    this.el.empty.classList.toggle('hidden', !show);
    if (show) {
      setChildren(
        this.el.empty,
        h('div', { class: 'empty-title' }, 'Drop three versions of a model here'),
        h('div', null, 'first = Base (common ancestor), then Ours, then Theirs · STL, OBJ, glTF, GLB'),
        h('div', { class: 'muted' }, 'or pick a merge example in the panel'),
      );
    }
  }

  private markDrop(side: MergeSide, state: 'loading' | 'ok' | 'error', message?: string): void {
    const d = this.el.drops[side];
    d.root.dataset.status = state;
    const loaded = this.models[side];
    if (state === 'loading') d.file.textContent = 'Loading…';
    else if (state === 'error') d.file.textContent = message ?? 'Failed to load';
    else if (loaded) {
      setChildren(
        d.file,
        h('span', { class: 'drop-name' }, loaded.name),
        h('span', { class: 'drop-meta' }, `${fmtInt(loaded.mesh.vertexCount)} v · ${fmtInt(loaded.mesh.faceCount)} f`),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** The CLI invocation(s) that reproduce the current resolutions. */
  private command(): string[] {
    const q = (s: string): string => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
    const picks = Object.entries(this.resolutions)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([id, r]) => `--pick ${id}=${r}`);
    const name = (s: MergeSide): string => q(this.models[s]?.name ?? `${s}.stl`);
    // Suggest the base's own format when it is writable (a glTF base keeps its nodes that way).
    const ext = (this.models.base?.name ?? '').toLowerCase().match(/\.([^.]+)$/)?.[1];
    const format = WRITABLE_FORMATS.find((f) => f === ext) ?? 'stl';
    const out = [[`polymerge merge ${name('base')} ${name('ours')} ${name('theirs')}`, `-o merged.${format}`, ...picks].join(' ')];
    if (this.repoPath) out.push([`polymerge resolve ${q(this.repoPath)}`, ...picks].join(' '));
    return out;
  }

  private download(format: WritableFormat): void {
    const v = this.view;
    if (!v) return;
    const stem = (this.models.base?.name ?? 'model').replace(/\.[^.]+$/, '');
    const name = `${stem}.merged.${format}`;
    const bytes = writeMesh(v.merged, format, { name });
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  // -------------------------------------------------------------------------
  // Status / errors / hook
  // -------------------------------------------------------------------------

  private setLoading(message: string): void {
    this.el.overlayMsg.textContent = message;
    this.el.overlay.classList.remove('hidden');
    this.hideError();
    this.publishState('loading');
  }

  private hideLoading(): void {
    this.el.overlay.classList.add('hidden');
  }

  private fail(title: string, err: unknown): void {
    const message = errorMessage(err);
    console.error(`[polymerge] ${title}:`, err);
    this.hideLoading();
    this.el.busy.classList.add('hidden');
    setChildren(
      this.el.error,
      h('div', { class: 'error-title' }, title),
      h('div', { class: 'error-msg' }, message),
      h('button', { class: 'icon', title: 'Dismiss', onclick: () => this.hideError() }, '×'),
    );
    this.el.error.classList.remove('hidden');
    this.publishState('error', `${title}: ${message}`);
  }

  private hideError(): void {
    this.el.error.classList.add('hidden');
  }

  private publishState(state: IPolymergeHook['state'], error?: string): void {
    const hook: IPolymergeHook = { state, mode: 'merge', source: this.source || undefined };
    if (error) hook.error = error;
    const v = this.view;
    if (v && state === 'ready') {
      hook.engine = this.engine.mode;
      hook.merge = this.hookState(v);
    }
    publish(hook);
  }

  private hookState(v: IMergeView): IMergeHookState {
    const faceKinds: Record<string, number> = {};
    for (const k of this.kinds) faceKinds[k] = (faceKinds[k] ?? 0) + 1;
    return {
      clean: v.clean,
      unresolved: v.conflicts.filter((c) => c.resolution === null).length,
      conflicts: v.conflicts.map((c) => ({
        id: c.id,
        kinds: c.kinds as Record<string, number>,
        resolution: c.resolution,
        baseVertices: c.baseVertices.length,
        focus: c.focus,
        screen: this.screenPoint(c.id),
      })),
      warnings: v.warnings.map((w) => w.message),
      stats: v.stats,
      merged: { vertices: v.merged.vertexCount, faces: v.merged.faceCount },
      tiers: { ours: v.ours.tier, theirs: v.theirs.tier },
      faceKinds,
      selected: this.selected,
      command: this.command().join('\n'),
      save: this.saveSession
        ? {
            path: this.saveSession.info.path,
            writable: this.saveSession.info.writable,
            enabled: this.el.output.querySelector<HTMLButtonElement>('[data-save="repo"]')?.disabled === false,
            state: this.saveState.state,
            message: this.saveState.message,
          }
        : undefined,
    };
  }

  /** Canvas position of the region face nearest the camera (a point a click will hit), if any. */
  private screenPoint(id: number): [number, number] | null {
    const v = this.view!;
    const m = v.merged;
    const eye = this.viewer.camera.position;
    let best: Vec3 | null = null;
    let bestD = Infinity;
    const c = new THREE.Vector3();
    for (let f = 0; f < this.conflictOf.length; f++) {
      if (this.conflictOf[f] !== id) continue;
      c.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        const i = m.faces[f * 3 + k] * 3;
        c.x += m.positions[i] / 3;
        c.y += m.positions[i + 1] / 3;
        c.z += m.positions[i + 2] / 3;
      }
      const d = c.distanceToSquared(eye);
      if (d < bestD) {
        bestD = d;
        best = [c.x, c.y, c.z];
      }
    }
    return best ? this.viewer.project(best) : null;
  }

  private setUrl(params: Record<string, string>): void {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams(params).toString();
    if (url.href !== window.location.href) history.replaceState(null, '', url);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof SourceError) return err.message;
  if (err instanceof MeshLoadError) return `${err.name}${err.format ? ` (${err.format})` : ''}: ${err.message}`;
  if (err instanceof Error) return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}
