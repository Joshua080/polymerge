/**
 * Test / automation hook. `window.__POLYMERGE__` always holds a fresh, JSON-safe
 * snapshot of the viewer state, and `document.body.dataset.state` mirrors `state`
 * so tests can simply wait for `body[data-state="ready"]`.
 */
import type { IDiffStats, IMeshSummary, ITierAttempt, IVertexChange, MatchTier } from '@polymerge/core';

export type ViewerState = 'idle' | 'loading' | 'ready' | 'error';

export interface ISelectionSnapshot extends IVertexChange {
  /** Which mesh the inspected vertex index refers to. */
  side: 'base' | 'target';
  index: number;
}

export interface IPolymergeHook {
  state: ViewerState;
  error?: string;
  tier?: MatchTier;
  tierName?: string;
  stats?: IDiffStats;
  attempts?: ITierAttempt[];
  base?: IMeshSummary;
  target?: IMeshSummary;
  /** Where the current pair came from: "mock", "case:<id>", "url" or "files". */
  source?: string;
  /** The vertex currently shown in the inspector, if any. */
  selection?: ISelectionSnapshot;
}

declare global {
  interface Window {
    __POLYMERGE__: IPolymergeHook;
  }
}

let current: IPolymergeHook = { state: 'idle' };

/** Replace the snapshot (fields not given are dropped) and mirror the state to <body>. */
export function publish(next: IPolymergeHook): void {
  current = JSON.parse(JSON.stringify(next)) as IPolymergeHook;
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
