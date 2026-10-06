/**
 * Test / automation hook. `window.__POLYMERGE__` always holds a fresh, JSON-safe
 * snapshot of the viewer state, and `document.body.dataset.state` mirrors `state`
 * so tests can simply wait for `body[data-state="ready"]`.
 */
import type { IDiffStats, IMergeStats, IMeshSummary, ITierAttempt, IVertexChange, MatchTier, MergeResolution, Vec3 } from 'polymerge-core';

export type ViewerState = 'idle' | 'loading' | 'ready' | 'error';

export interface ISelectionSnapshot extends IVertexChange {
  /** Which mesh the inspected vertex index refers to. */
  side: 'base' | 'target';
  index: number;
}

/** Merge review state (mode 'merge'). */
export interface IMergeHookState {
  clean: boolean;
  unresolved: number;
  conflicts: {
    id: number;
    kinds: Record<string, number>;
    resolution: MergeResolution | null;
    baseVertices: number;
    focus: Vec3;
    /** Canvas position (CSS px) of a visible point of the region, for clicking it; null if off-screen. */
    screen: [number, number] | null;
  }[];
  warnings: string[];
  stats: IMergeStats;
  merged: { vertices: number; faces: number };
  tiers: { ours: MatchTier; theirs: MatchTier };
  /** Merged faces per colour class. */
  faceKinds: Record<string, number>;
  selected: number | null;
  /** The equivalent CLI command for the current resolutions. */
  command: string;
  /** "Save to repository", present only in a `polymerge review` session that offers it. */
  save?: {
    path: string;
    writable: boolean;
    /** The Save button is enabled. */
    enabled: boolean;
    state: 'idle' | 'saving' | 'saved' | 'error';
    message?: string;
  };
}

/** Capture mode state (mode 'capture': the fixed before / after card). */
export interface ICaptureHookState {
  /** 'diff': both versions; 'added' / 'deleted': one side only. */
  kind: 'diff' | 'added' | 'deleted';
  /** The view direction both panels use (from the model towards the camera). */
  direction: Vec3;
  panels: {
    side: 'base' | 'target';
    /** Whether the panel has a model (an added file has no before). */
    empty: boolean;
    /** The panel's canvas within the card element: x, y, width, height in CSS px. */
    rect: [number, number, number, number];
    /** DiffViewer.cameraState(): identical in both panels when the framing is shared. */
    camera: number[];
  }[];
}

export interface IPolymergeHook {
  state: ViewerState;
  /** Which viewer is open: two-way diff (default), three-way merge review, or the capture card. */
  mode?: 'diff' | 'merge' | 'capture';
  merge?: IMergeHookState;
  capture?: ICaptureHookState;
  error?: string;
  tier?: MatchTier;
  tierName?: string;
  stats?: IDiffStats;
  attempts?: ITierAttempt[];
  base?: IMeshSummary;
  target?: IMeshSummary;
  /** Where the current pair came from: "mock", "case:<id>", "url" or "files". */
  source?: string;
  /** Where the last diff ran: in the Web Worker, or on the main thread (fallback). */
  engine?: 'worker' | 'main';
  /** Number of reported part motions in the result. */
  parts?: number;
  /** When the last diff computed, epoch ms [start, end] (for responsiveness checks). */
  diffWindow?: [number, number];
  /** The vertex currently shown in the inspector, if any. */
  selection?: ISelectionSnapshot;
  /** How the models are shown: which axis is up, and the colour palette. */
  view?: { up: 'y' | 'z'; palette: 'standard' | 'colorblind' };
}

declare global {
  interface Window {
    __POLYMERGE__: IPolymergeHook;
  }
}

let current: IPolymergeHook = { state: 'idle' };
let viewProvider: (() => IPolymergeHook['view']) | null = null;

/** Where `view` comes from (the open viewer); it is added to every snapshot. */
export function setViewProvider(fn: () => IPolymergeHook['view']): void {
  viewProvider = fn;
}

/** Replace the snapshot (fields not given are dropped) and mirror the state to <body>. */
export function publish(next: IPolymergeHook): void {
  current = JSON.parse(JSON.stringify(viewProvider ? { ...next, view: viewProvider() } : next)) as IPolymergeHook;
  window.__POLYMERGE__ = current;
  document.body.dataset.state = current.state;
}

/** Shallow-merge into the current snapshot. */
export function patch(fields: Partial<IPolymergeHook>): void {
  publish({ ...current, ...fields });
}

export function snapshot(): IPolymergeHook {
  return current;
}
