/**
 * Diff worker: runs the (synchronous, CPU-heavy) correspondence engine off the main thread so
 * the viewer stays responsive — the spinner animates and the camera can still orbit while a
 * large model is being diffed. Engine log lines are streamed back as they happen.
 */
import { diffMeshes } from '@polymerge/core';
import { resultTransferables, type IDiffRequest, type WorkerMessage } from './protocol.js';

const post = (msg: WorkerMessage, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);
};

self.onmessage = (ev: MessageEvent<IDiffRequest>) => {
  const req = ev.data;
  if (req?.type !== 'diff') return;
  const t0 = performance.now();
  const log = (level: 'info' | 'warn' | 'debug') => (message: string) => post({ type: 'log', id: req.id, level, message });
  try {
    const result = diffMeshes(req.base, req.target, {
      ...req.options,
      logger: { info: log('info'), warn: log('warn'), debug: log('debug') },
    });
    post({ type: 'result', id: req.id, result, ms: performance.now() - t0 }, resultTransferables(result));
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    post({ type: 'error', id: req.id, message: e.message, stack: e.stack });
  }
};
