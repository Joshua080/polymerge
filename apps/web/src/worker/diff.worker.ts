/**
 * Engine worker: runs the (synchronous, CPU-heavy) diff and merge engines off the main thread
 * so the viewer stays responsive — the spinner animates and the camera can still orbit while a
 * large model is being processed. Engine log lines are streamed back as they happen.
 *
 * The last merge is kept here: resolving a conflict re-materialises it (resolveMerge) without
 * recomputing its two diffs, and always starts from the unresolved merge, so the viewer sends
 * the complete set of resolutions each time (which also lets it un-resolve a conflict).
 */
import { diffMeshes, mergeMeshes, resolveMerge, type IDiffLogger, type IMergeResult } from 'polymerge-core';
import { mergeView, resultTransferables, type WorkerMessage, type WorkerRequest } from './protocol.js';

const post = (msg: WorkerMessage, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);
};

let lastMerge: IMergeResult | null = null;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (!req || typeof req !== 'object') return;
  const t0 = performance.now();
  const startedAt = performance.timeOrigin + t0;
  const log = (level: 'info' | 'warn' | 'debug') => (message: string) => post({ type: 'log', id: req.id, level, message });
  const logger: IDiffLogger = { info: log('info'), warn: log('warn'), debug: log('debug') };
  const timing = (): { ms: number; startedAt: number; finishedAt: number } => {
    const t1 = performance.now();
    return { ms: t1 - t0, startedAt, finishedAt: performance.timeOrigin + t1 };
  };
  try {
    if (req.type === 'diff') {
      const result = diffMeshes(req.base, req.target, { ...req.options, logger });
      post({ type: 'result', id: req.id, result, ...timing() }, resultTransferables(result));
    } else if (req.type === 'merge') {
      lastMerge = null;
      const result = mergeMeshes(req.base, req.ours, req.theirs, { ...req.options, diff: { ...req.options.diff, logger }, logger });
      lastMerge = result;
      post({ type: 'merged', id: req.id, view: mergeView(result), ...timing() });
    } else if (req.type === 'resolve') {
      if (!lastMerge) throw new Error('no merge to resolve (run a merge first)');
      const result = resolveMerge(lastMerge, req.resolutions, { logger });
      post({ type: 'merged', id: req.id, view: mergeView(result), ...timing() });
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    post({ type: 'error', id: req.id, message: e.message, stack: e.stack });
  }
};
