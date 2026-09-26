/** Application controller: wires inputs, loading, diffing, the viewer and the panel together. */
import {
  DIFF_COLORS,
  MeshLoadError,
  TIER_NAMES,
  describeVertexChange,
  getPosition,
  serializeDiff,
  summarizeMesh,
  type IDiffOptions,
  type IDiffResult,
  type IFixtureCase,
  type MatchTier,
  type Vec3,
} from '@polymerge/core';
import { h, nextFrame, setChildren, swatch } from './dom.js';
import { DiffEngine } from './engine.js';
import { patch, publish, snapshot, type IPolymergeHook } from './hook.js';
import {
  renderAttempts,
  renderInspector,
  renderMeshes,
  renderSummary,
  stripTierPrefix,
  type IInspectorModel,
} from './panels.js';
import { DEFAULT_LAYERS, DiffViewer, type ILayerCounts, type ILayerVisibility, type IPickHit } from './scene/viewer.js';
import { BASE_ACCENT } from './scene/layers.js';
import {
  ACCEPTED_EXTENSIONS,
  SourceError,
  fixtureUrl,
  loadFromFile,
  loadFromUrl,
  loadManifest,
  type ILoadedMesh,
  type IManifestInfo,
} from './sources.js';

type Side = 'base' | 'target';
const SIDE_LABEL: Record<Side, string> = { base: 'Base (old)', target: 'Target (new)' };

/** Layers whose default depends on how much there is to draw (until the user touches them). */
const AUTO_LIMITS: Partial<Record<keyof ILayerVisibility, (c: ILayerCounts) => boolean>> = {
  vectors: (c) => c.vectors <= 5000,
  markers: (c) => c.markers <= 1500,
};

const LAYER_DEFS: { key: keyof ILayerVisibility; label: string; color?: string; hint: string }[] = [
  { key: 'target', label: 'Target (diff-coloured)', color: DIFF_COLORS.modified, hint: 'New mesh, faces coloured by status' },
  { key: 'removed', label: 'Removed geometry', color: DIFF_COLORS.removed, hint: 'Base faces that no longer exist' },
  { key: 'ghost', label: 'Base ghost', color: BASE_ACCENT, hint: 'Whole old mesh, translucent, in target space' },
  { key: 'unchanged', label: 'Show unchanged faces', color: DIFF_COLORS.unchanged, hint: 'Grey faces of the target' },
  { key: 'markers', label: 'Vertex markers', hint: 'Dots: moved (yellow), added (green), removed (red)' },
  { key: 'vectors', label: 'Displacement vectors', hint: 'Old (blue) → new (yellow) position of moved vertices' },
  { key: 'wireframe', label: 'Wireframe overlay', hint: 'Triangle edges' },
];

export class App {
  private readonly viewer: DiffViewer;
  private base: ILoadedMesh | null = null;
  private target: ILoadedMesh | null = null;
  private result: IDiffResult | null = null;
  private layerCounts: ILayerCounts | null = null;
  private source = '';
  private seq = 0;
  private engineLog: string[] = [];
  /** Runs diffMeshes in a Web Worker (main-thread fallback). */
  private readonly engine = new DiffEngine(new URLSearchParams(location.search).get('worker') !== '0');
  private manifest: Promise<IManifestInfo | null>;
  private currentCase: IFixtureCase | null = null;
  private touchedLayers = new Set<keyof ILayerVisibility>();
  private layers: ILayerVisibility = { ...DEFAULT_LAYERS };
  private selection: { side: Side; index: number; hit: IPickHit | null } | null = null;

  // DOM refs
  private readonly el = {
    drops: {} as Record<Side, { root: HTMLElement; file: HTMLElement; input: HTMLInputElement }>,
    examples: h('select', { id: 'examples', 'aria-label': 'Examples' }),
    exampleInfo: h('p', { class: 'example-info muted' }),
    tierSelect: h('select', { id: 'tier-select', 'aria-label': 'Tier', title: 'Tier selection for (re-)running the diff' }),
    rerun: h('button', { id: 'rerun', disabled: true }, 'Re-run diff'),
    reset: h('button', { id: 'reset-view' }, 'Reset view'),
    download: h('button', { id: 'download-json', class: 'small', disabled: true, title: 'serializeDiff(result) as a .json file' }, 'Download diff JSON'),
    summary: h('div', { class: 'summary' }),
    attempts: h('div', { class: 'attempts-wrap' }),
    engineLog: h('pre', { class: 'engine-log' }),
    layers: h('div', { class: 'layers' }),
    meshes: h('div', { class: 'meshes-wrap' }),
    inspectSide: h('select', { 'aria-label': 'Vertex side' }),
    inspectIndex: h('input', { type: 'number', min: '0', step: '1', placeholder: 'vertex #', 'aria-label': 'Vertex index' }),
    inspector: h('div', { class: 'inspector hidden' }),
    overlay: h('div', { class: 'loading hidden' }),
    overlayMsg: h('div', { class: 'loading-msg' }),
    error: h('div', { class: 'error-banner hidden', role: 'alert' }),
    empty: h('div', { class: 'empty-hint' }),
    hudTier: h('div', { class: 'hud-tier hidden' }),
    viewport: h('div', { class: 'viewport' }),
  };

  constructor(root: HTMLElement) {
    this.buildLayout(root);
    this.viewer = new DiffViewer(this.el.viewport);
    this.viewer.onPick = (hit) => {
      if (hit) this.inspect(hit.side, hit.vertex, hit);
      else this.clearSelection();
    };
    this.renderLayers();
    this.renderEmpty();
    this.manifest = loadManifest();
    void this.populateExamples();
    publish({ state: 'idle' });
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  private buildLayout(root: HTMLElement): void {
    const el = this.el;
    const drop = (side: Side) => {
      const input = h('input', { type: 'file', accept: ACCEPTED_EXTENSIONS.join(','), class: 'hidden-input', 'aria-label': SIDE_LABEL[side] });
      const file = h('span', { class: 'drop-file' }, 'Drop a model or click to browse');
      const rootEl = h(
        'label',
        { class: 'drop', dataset: { side } },
        input,
        h('span', { class: 'drop-title' }, SIDE_LABEL[side]),
        file,
      );
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
      el.drops[side] = { root: rootEl, file, input };
      return rootEl;
    };

    el.tierSelect.append(
      h('option', { value: '' }, 'Auto (tier 1 → 2 → 3)'),
      ...([1, 2, 3] as MatchTier[]).map((t) => h('option', { value: String(t) }, `Force ${TIER_NAMES[t]}`)),
    );
    el.inspectSide.append(h('option', { value: 'target' }, 'target'), h('option', { value: 'base' }, 'base'));
    el.examples.addEventListener('change', () => {
      const id = el.examples.value;
      if (id) void this.loadCase(id);
    });
    el.rerun.addEventListener('click', () => void this.runDiff());
    el.reset.addEventListener('click', () => this.viewer.resetView());
    el.download.addEventListener('click', () => this.downloadJson());

    const inspectForm = h(
      'form',
      { class: 'inspect-form' },
      el.inspectSide,
      el.inspectIndex,
      h('button', { type: 'submit' }, 'Inspect'),
    );
    inspectForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const idx = Number(el.inspectIndex.value);
      if (Number.isInteger(idx)) this.inspect(el.inspectSide.value as Side, idx, null);
    });

    el.overlay.append(h('div', { class: 'spinner' }), el.overlayMsg);

    const legend = h(
      'div',
      { class: 'hud-legend' },
      ([
        [DIFF_COLORS.unchanged, 'Unchanged'],
        [DIFF_COLORS.modified, 'Moved / Modified'],
        [DIFF_COLORS.added, 'Added'],
        [DIFF_COLORS.removed, 'Removed'],
      ] as const).map(([c, l]) => h('span', null, swatch(c), l)),
    );

    const panel = h(
      'aside',
      { class: 'panel' },
      h(
        'header',
        { class: 'brand' },
        h('span', { class: 'logo' }, 'polymerge'),
        h('span', { class: 'tagline' }, 'vertex-level 3D diff'),
      ),
      h(
        'section',
        { class: 'sec' },
        h('h2', null, 'Models'),
        h('div', { class: 'drops' }, drop('base'), drop('target')),
        h('div', { class: 'row' }, el.examples),
        el.exampleInfo,
        h('div', { class: 'row' }, el.tierSelect),
        h('div', { class: 'row buttons' }, el.rerun, el.reset),
      ),
      h('section', { class: 'sec' }, h('h2', null, 'Result'), el.summary, h('div', { class: 'row' }, el.download)),
      h('section', { class: 'sec' }, h('h2', null, 'Layers'), el.layers),
      h(
        'section',
        { class: 'sec' },
        h('h2', null, 'Inspect'),
        h('p', { class: 'muted small' }, 'Click the model, or look up a vertex by index.'),
        inspectForm,
      ),
      h('section', { class: 'sec' }, h('h2', null, 'Tier attempts'), el.attempts),
      h('section', { class: 'sec' }, h('h2', null, 'Meshes'), el.meshes),
      h(
        'section',
        { class: 'sec' },
        h('details', null, h('summary', null, 'Engine log'), el.engineLog),
      ),
    );

    const stage = h(
      'main',
      { class: 'stage' },
      el.viewport,
      el.hudTier,
      legend,
      h('div', { class: 'hud-hint' }, 'drag: orbit · right-drag: pan · wheel: zoom · click: inspect vertex'),
      el.empty,
      el.inspector,
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
      if (files.length >= 2) void this.loadFiles([['base', files[0]], ['target', files[1]]]);
      else if (files.length === 1) void this.loadFiles([[this.base && !this.target ? 'target' : 'base', files[0]]]);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.clearSelection();
    });

    root.append(h('div', { class: 'app' }, panel, stage));
    this.renderSummary();
    this.renderMeshes();
    this.renderAttemptsPlaceholder();
  }

  // -------------------------------------------------------------------------
  // Entry: URL parameters
  // -------------------------------------------------------------------------

  async start(params: URLSearchParams): Promise<void> {
    const mock = params.get('mock');
    const caseId = params.get('case');
    const baseUrl = params.get('base');
    const targetUrl = params.get('target');
    const tier = params.get('tier');
    if (tier && ['1', '2', '3'].includes(tier)) this.el.tierSelect.value = tier;
    if (mock !== null && mock !== '0' && mock !== 'false') return this.loadMock(mock === '3' || mock === 'tier3' ? 'tier3' : 'tier2');
    if (caseId) return this.loadCase(caseId);
    if (baseUrl && targetUrl) {
      return this.loadPair(
        {
          base: () => loadFromUrl(baseUrl, params.get('baseName') ?? undefined),
          target: () => loadFromUrl(targetUrl, params.get('targetName') ?? undefined),
        },
        'url',
      );
    }
    if (baseUrl || targetUrl) {
      const side: Side = baseUrl ? 'base' : 'target';
      return this.loadSide(side, () => loadFromUrl((baseUrl ?? targetUrl)!, params.get(`${side}Name`) ?? undefined), 'url');
    }
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async populateExamples(): Promise<void> {
    const sel = this.el.examples;
    sel.replaceChildren(h('option', { value: '' }, 'Loading examples…'));
    sel.disabled = true;
    const info = await this.manifest;
    const cases = info?.manifest.cases ?? [];
    if (cases.length === 0) {
      sel.replaceChildren(h('option', { value: '' }, 'No examples available'));
      return;
    }
    sel.replaceChildren(
      h('option', { value: '' }, `Examples (${cases.length})…`),
      ...cases.map((c) => h('option', { value: c.id, title: c.description }, c.title || c.id)),
    );
    sel.disabled = false;
    if (this.currentCase) sel.value = this.currentCase.id;
  }

  async loadCase(id: string): Promise<void> {
    const seq = ++this.seq;
    this.setLoading(`Loading example “${id}”…`);
    const info = await this.manifest;
    if (seq !== this.seq) return;
    const c = info?.manifest.cases.find((x) => x.id === id);
    if (!info || !c) {
      this.fail(
        'Example not found',
        new Error(info ? `No example with id "${id}" in fixtures/manifest.json.` : 'No examples available (fixtures/manifest.json is missing).'),
      );
      return;
    }
    this.currentCase = c;
    this.el.examples.value = c.id;
    this.setUrl({ case: c.id });
    await this.loadPair(
      { base: () => loadFromUrl(fixtureUrl(info, c.base)), target: () => loadFromUrl(fixtureUrl(info, c.target)) },
      `case:${c.id}`,
      seq,
    );
  }

  private async loadFiles(entries: [Side, File][]): Promise<void> {
    this.currentCase = null;
    this.el.examples.value = '';
    this.setUrl({});
    if (entries.length === 2) {
      const [[, b], [, t]] = entries;
      await this.loadPair({ base: () => loadFromFile(b), target: () => loadFromFile(t) }, 'files');
    } else {
      const [side, file] = entries[0];
      await this.loadSide(side, () => loadFromFile(file), 'files');
    }
  }

  /** Load both sides, then diff. */
  async loadPair(loaders: Record<Side, () => Promise<ILoadedMesh>>, source: string, seq = ++this.seq): Promise<void> {
    this.setLoading('Loading models…');
    this.markDrop('base', 'loading');
    this.markDrop('target', 'loading');
    const sides: Side[] = ['base', 'target'];
    const settled = await Promise.allSettled(sides.map((side) => this.loadOne(side, loaders[side])));
    if (seq !== this.seq) return;
    const errors: unknown[] = [];
    settled.forEach((r, i) => {
      const side = sides[i];
      if (r.status === 'fulfilled') {
        this[side] = r.value;
        this.markDrop(side, 'ok');
      } else {
        // Never diff a fresh model against a stale one from an earlier pair.
        this[side] = null;
        errors.push(r.reason);
      }
    });
    this.source = source;
    this.renderMeshes();
    if (errors.length > 0) {
      await this.showPartial();
      const err = errors.length === 1 ? errors[0] : new Error(errors.map(errorMessage).join('\n'));
      if (seq === this.seq) this.fail('Could not load models', err);
      return;
    }
    await this.runDiff(seq);
  }

  /** Load one side; diff if the other side is present, else preview. */
  private async loadSide(side: Side, loader: () => Promise<ILoadedMesh>, source: string): Promise<void> {
    const seq = ++this.seq;
    this.setLoading(`Loading ${SIDE_LABEL[side].toLowerCase()}…`);
    this.markDrop(side, 'loading');
    let loaded: ILoadedMesh;
    try {
      loaded = await this.loadOne(side, loader);
    } catch (err) {
      if (seq === this.seq) this.fail('Could not load model', err);
      return;
    }
    if (seq !== this.seq) return;
    this[side] = loaded;
    this.source = source;
    this.markDrop(side, 'ok');
    this.renderMeshes();
    if (this.base && this.target) {
      await this.runDiff(seq);
      return;
    }
    await this.showPartial();
    if (seq !== this.seq) return;
    this.hideLoading();
    this.publishState('idle');
  }

  /** At most one side loaded: grey preview of it (or an empty scene), no diff result. */
  private async showPartial(): Promise<void> {
    this.result = null;
    this.layerCounts = null;
    this.clearSelection();
    const only = this.base ? { side: 'base' as const, m: this.base } : this.target ? { side: 'target' as const, m: this.target } : null;
    if (only) this.viewer.showPreview(only.m.mesh, only.side);
    else this.viewer.clear();
    this.el.hudTier.classList.add('hidden');
    this.renderSummary();
    this.renderLayers();
    this.renderAttemptsPlaceholder();
    this.renderEmpty();
    this.el.rerun.disabled = true;
    await this.viewer.whenRendered();
  }

  private async loadOne(side: Side, loader: () => Promise<ILoadedMesh>): Promise<ILoadedMesh> {
    try {
      return await loader();
    } catch (err) {
      this.markDrop(side, 'error', errorMessage(err));
      throw new SideError(side, err);
    }
  }

  async loadMock(variant: 'tier2' | 'tier3'): Promise<void> {
    const seq = ++this.seq;
    this.setLoading('Generating mock diff…');
    try {
      const { createMockPair } = await import('./dev/mock.js');
      const pair = createMockPair(variant);
      if (seq !== this.seq) return;
      this.base = { mesh: pair.base, name: pair.base.metadata.sourceName ?? 'mock base', bytes: 0, origin: 'mock' };
      this.target = { mesh: pair.target, name: pair.target.metadata.sourceName ?? 'mock target', bytes: 0, origin: 'mock' };
      this.source = 'mock';
      this.markDrop('base', 'ok');
      this.markDrop('target', 'ok');
      this.engineLog = ['[mock] result generated in the browser by src/dev/mock.ts (not by diffMeshes)'];
      this.renderMeshes();
      await this.showResult(pair.result, seq);
    } catch (err) {
      if (seq === this.seq) this.fail('Mock failed', err);
    }
  }

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  async runDiff(seq = ++this.seq): Promise<void> {
    const base = this.base;
    const target = this.target;
    if (!base || !target) return;
    this.setLoading('Computing diff…');
    // Let the overlay paint first (matters for the main-thread fallback; the worker never blocks).
    await nextFrame();
    if (seq !== this.seq) return;
    const log: string[] = [];
    const options: Omit<IDiffOptions, 'logger'> = {};
    const forced = Number(this.el.tierSelect.value);
    if (forced === 1 || forced === 2 || forced === 3) options.forceTier = forced;
    let result: IDiffResult;
    try {
      result = await this.engine.run(base.mesh, target.mesh, options, (level, m) => {
        if (level === 'info') {
          log.push(m);
          console.info(m);
          // Live progress in the overlay (tier attempts as they happen).
          if (seq === this.seq) this.el.overlayMsg.textContent = m.replace(/^\[polymerge\]\s*/, '');
        } else if (level === 'warn') {
          log.push(`WARN ${m}`);
          console.warn(m);
        } else log.push(`debug ${m}`);
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // superseded by a newer diff
      this.engineLog = log;
      this.renderEngineLog();
      if (seq === this.seq) this.fail('Diff failed', err);
      return;
    }
    if (seq !== this.seq) return;
    this.engineLog = log;
    await this.showResult(result, seq);
  }

  private async showResult(result: IDiffResult, seq: number): Promise<void> {
    const base = this.base!;
    const target = this.target!;
    this.result = result;
    this.clearSelection();
    this.layerCounts = this.viewer.showDiff(base.mesh, target.mesh, result);
    // Adaptive defaults for dense layers, unless the user chose explicitly.
    for (const [key, ok] of Object.entries(AUTO_LIMITS) as [keyof ILayerVisibility, (c: ILayerCounts) => boolean][]) {
      if (!this.touchedLayers.has(key)) this.layers[key] = ok(this.layerCounts);
    }
    this.viewer.setLayers(this.layers);
    this.renderSummary();
    this.renderLayers();
    this.el.attempts.replaceChildren(renderAttempts(result.attempts));
    this.renderEngineLog();
    this.renderEmpty();
    this.renderCaseInfo();
    this.el.hudTier.classList.remove('hidden');
    setChildren(this.el.hudTier, h('strong', null, `Tier ${result.tier}`), ` ${stripTierPrefix(result.tierName, result.tier)}`);
    this.el.rerun.disabled = false;
    await this.viewer.whenRendered();
    if (seq !== this.seq) return;
    this.hideLoading();
    this.hideError();
    this.publishState('ready');
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  inspect(side: Side, index: number, hit: IPickHit | null): void {
    const mesh = side === 'base' ? this.base?.mesh : this.target?.mesh;
    if (!mesh || !Number.isInteger(index) || index < 0 || index >= mesh.vertexCount) {
      this.clearSelection();
      this.el.inspector.classList.remove('hidden');
      setChildren(
        this.el.inspector,
        h(
          'div',
          { class: 'inspector-card' },
          h('div', { class: 'insp-head' }, h('span', null, 'Vertex inspector')),
          h('p', { class: 'note' }, mesh ? `No ${side} vertex #${index} (valid: 0 … ${mesh.vertexCount - 1}).` : `No ${side} mesh loaded.`),
        ),
      );
      return;
    }
    this.selection = { side, index, hit };
    const result = this.result;
    if (result && this.base && this.target) {
      const change = describeVertexChange(result, this.base.mesh, this.target.mesh, side, index);
      this.viewer.setSelection(change.to ? { to: change.to, from: change.from } : { to: change.from, from: null });
      this.showInspector({
        side,
        index,
        change,
        hit,
        result,
        base: this.base.mesh,
        target: this.target.mesh,
        rawPosition: getPosition(mesh, index),
      });
      patch({ selection: { side, index, ...change } });
    } else {
      const p = getPosition(mesh, index);
      this.viewer.setSelection({ to: p, from: null });
      this.showInspector({ side, index, change: null, hit, result: null, base: this.base?.mesh ?? null, target: this.target?.mesh ?? null, rawPosition: p });
    }
  }

  private showInspector(model: IInspectorModel): void {
    this.el.inspector.classList.remove('hidden');
    setChildren(
      this.el.inspector,
      renderInspector(model, {
        inspect: (s, i) => this.inspect(s, i, null),
        focus: (p: Vec3) => this.viewer.focus(p),
        close: () => this.clearSelection(),
      }),
    );
  }

  clearSelection(): void {
    this.selection = null;
    this.viewer.setSelection(null);
    this.el.inspector.classList.add('hidden');
    this.el.inspector.replaceChildren();
    if (snapshot().selection) {
      const { selection: _drop, ...rest } = snapshot();
      publish(rest);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------

  private downloadJson(): void {
    if (!this.result) return;
    let json: string;
    try {
      json = serializeDiff(this.result);
    } catch (err) {
      this.fail('Export failed', err);
      return;
    }
    const stem = (m: ILoadedMesh | null) => (m?.name ?? 'mesh').replace(/\.[^.]+$/, '');
    const a = h('a', {
      href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
      download: `${stem(this.base)}__${stem(this.target)}.polymerge.json`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  private renderSummary(): void {
    this.el.download.disabled = !this.result;
    if (this.result) setChildren(this.el.summary, renderSummary(this.result));
    else
      setChildren(
        this.el.summary,
        h('p', { class: 'muted' }, this.base || this.target ? 'Waiting for the second model…' : 'Load a Base and a Target model to compute a diff.'),
      );
  }

  private renderMeshes(): void {
    setChildren(this.el.meshes, renderMeshes(this.base, this.target));
    const names = [this.base?.name, this.target?.name].filter(Boolean);
    document.title = names.length > 0 ? `${names.join(' → ')} · polymerge` : 'polymerge viewer';
  }

  private renderAttemptsPlaceholder(): void {
    setChildren(this.el.attempts, h('p', { class: 'muted' }, 'No diff has run yet.'));
  }

  private renderEngineLog(): void {
    this.el.engineLog.textContent = this.engineLog.length > 0 ? this.engineLog.join('\n') : '(no engine output)';
  }

  private renderCaseInfo(): void {
    const c = this.currentCase;
    if (!c || this.source !== `case:${c.id}`) {
      this.el.exampleInfo.replaceChildren();
      return;
    }
    const tiers = c.expect.acceptableTiers;
    const got = this.result?.tier;
    const ok = got !== undefined && tiers.includes(got);
    const desc = h('span', { class: 'desc', title: 'Click to expand / collapse' }, c.description);
    desc.addEventListener('click', () => desc.classList.toggle('expanded'));
    setChildren(
      this.el.exampleInfo,
      desc,
      h(
        'span',
        { class: 'expect' },
        `Expected tier ${tiers.join(' or ')}`,
        got !== undefined ? h('span', { class: ok ? 'ok' : 'bad' }, ` · got ${got} ${ok ? '✓' : '✗'}`) : null,
      ),
    );
  }

  private renderLayers(): void {
    const counts = this.layerCounts;
    const countLabel: Partial<Record<keyof ILayerVisibility, string>> = counts
      ? {
          target: `${counts.targetFaces.toLocaleString('en-US')} faces`,
          removed: `${counts.removedFaces.toLocaleString('en-US')} faces`,
          unchanged: `${(counts.targetFaces - counts.changedTargetFaces).toLocaleString('en-US')} faces`,
          markers: `${counts.markers.toLocaleString('en-US')}`,
          vectors: `${counts.vectors.toLocaleString('en-US')}`,
        }
      : {};
    setChildren(
      this.el.layers,
      LAYER_DEFS.map((def) => {
        const input = h('input', { type: 'checkbox', checked: this.layers[def.key], dataset: { layer: def.key } });
        input.addEventListener('change', () => {
          this.touchedLayers.add(def.key);
          this.layers[def.key] = input.checked;
          this.viewer.setLayers({ [def.key]: input.checked });
        });
        const icon =
          def.key === 'markers'
            ? h('span', { class: 'swatch-group' }, swatch(DIFF_COLORS.modified), swatch(DIFF_COLORS.added), swatch(DIFF_COLORS.removed))
            : def.key === 'vectors'
              ? h('span', { class: 'swatch vector', style: { background: `linear-gradient(90deg, ${BASE_ACCENT}, ${DIFF_COLORS.modified})` } })
              : def.key === 'wireframe'
                ? h('span', { class: 'swatch wire' })
                : swatch(def.color ?? DIFF_COLORS.unchanged);
        return h(
          'label',
          { class: 'layer', title: def.hint },
          input,
          icon,
          h('span', { class: 'layer-label' }, def.label),
          countLabel[def.key] ? h('span', { class: 'layer-count' }, countLabel[def.key]!) : null,
        );
      }),
    );
  }

  private renderEmpty(): void {
    const show = !this.base && !this.target;
    this.el.empty.classList.toggle('hidden', !show);
    if (show) {
      setChildren(
        this.el.empty,
        h('div', { class: 'empty-title' }, 'Drop two versions of a model here'),
        h('div', null, 'first = Base (old), second = Target (new) · STL, OBJ, glTF, GLB'),
        h('div', { class: 'muted' }, 'or pick an example in the panel'),
      );
    }
  }

  private markDrop(side: Side, state: 'loading' | 'ok' | 'error', message?: string): void {
    const d = this.el.drops[side];
    d.root.dataset.status = state;
    const loaded = this[side];
    if (state === 'loading') d.file.textContent = 'Loading…';
    else if (state === 'error') d.file.textContent = message ?? 'Failed to load';
    else if (loaded) {
      setChildren(
        d.file,
        h('span', { class: 'drop-name' }, loaded.name),
        h('span', { class: 'drop-meta' }, `${loaded.mesh.metadata.format.toUpperCase()} · ${loaded.mesh.vertexCount.toLocaleString('en-US')} v · ${loaded.mesh.faceCount.toLocaleString('en-US')} f`),
      );
    }
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
    const r = this.result;
    const hook: IPolymergeHook = { state, source: this.source || undefined };
    if (error) hook.error = error;
    if (r && state === 'ready') {
      hook.tier = r.tier;
      hook.tierName = r.tierName;
      hook.stats = r.stats;
      hook.attempts = r.attempts;
      hook.base = r.base;
      hook.target = r.target;
      hook.engine = this.engine.mode;
      hook.parts = r.parts?.length ?? 0;
    } else {
      if (this.base) hook.base = summarizeMesh(this.base.mesh);
      if (this.target) hook.target = summarizeMesh(this.target.mesh);
    }
    const sel = snapshot().selection;
    if (sel && this.selection && state === 'ready') hook.selection = sel;
    publish(hook);
  }

  private setUrl(params: Record<string, string>): void {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams(params).toString();
    if (url.href !== window.location.href) history.replaceState(null, '', url);
  }
}

class SideError extends Error {
  constructor(
    readonly side: Side,
    readonly inner: unknown,
  ) {
    super(`${SIDE_LABEL[side]}: ${errorMessage(inner)}`);
    this.name = 'SideError';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof SideError || err instanceof SourceError) return err.message;
  if (err instanceof MeshLoadError) return `${err.name}${err.format ? ` (${err.format})` : ''}: ${err.message}`;
  if (err instanceof Error) return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}
