/**
 * DiffEngine — runs the diff (and merge) engines in a Web Worker (one persistent module worker),
 * falling back to the main thread when workers are unavailable. A newer run supersedes an older
 * one: the busy worker is terminated (its CPU work is wasted anyway) and a fresh one is started.
 */
import {
  diffMeshes,
  mergeMeshes,
  resolveMerge,
  type IDiffLogger,
  type IDiffResult,
  type IMergeResult,
  type IMesh,
  type MergeResolution,
} from 'polymerge-core';
import {
  mergeView,
  type IMergeView,
  type WorkerDiffOptions,
  type WorkerMergeOptions,
  type WorkerMessage,
  type WorkerRequest,
} from './worker/protocol.js';

export type EngineMode = 'worker' | 'main';

export interface IEngineLog {
  (level: 'info' | 'warn' | 'debug', message: string): void;
}

/** A request without its id (assigned per call). */
type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export class DiffEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  /** The job in flight: its kind, how to reject it, and how to detach its listeners. */
  private pending: { id: number; kind: Request['type']; reject: (e: Error) => void; detach: () => void } | null = null;
  /** The merge the main-thread fallback re-resolves (the worker keeps its own). */
  private localMerge: IMergeResult | null = null;
  /** How the last run actually ran. */
  mode: EngineMode = 'worker';
  /** When the last run computed, in epoch milliseconds [start, end] (worker or main thread). */
  lastWindow: [number, number] | null = null;

  private useWorker: boolean;

  constructor(useWorker = typeof Worker !== 'undefined') {
    this.useWorker = useWorker;
  }

  private spawn(): Worker | null {
    if (!this.useWorker) return null;
    try {
      return new Worker(new URL('./worker/diff.worker.ts', import.meta.url), { type: 'module', name: 'polymerge-engine' });
    } catch (err) {
      console.warn('[polymerge] could not start the engine worker; running on the main thread', err);
      return null;
    }
  }

  /**
   * Cancel the running job (if any): its promise rejects with an AbortError. A long diff or merge
   * is stopped by terminating the worker; a resolve is quick and the worker holds the merge it
   * works on, so it is only abandoned (the worker finishes it and its result is ignored).
   */
  cancel(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.detach();
    const err = new Error('superseded by a newer run');
    err.name = 'AbortError';
    p.reject(err);
    if (p.kind !== 'resolve' && this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  run(base: IMesh, target: IMesh, options: WorkerDiffOptions, onLog: IEngineLog): Promise<IDiffResult> {
    return this.call<IDiffResult>({ type: 'diff', base, target, options }, onLog, (logger) =>
      diffMeshes(base, target, { ...options, logger }),
    );
  }

  merge(base: IMesh, ours: IMesh, theirs: IMesh, options: WorkerMergeOptions, onLog: IEngineLog): Promise<IMergeView> {
    this.localMerge = null;
    return this.call<IMergeView>({ type: 'merge', base, ours, theirs, options }, onLog, (logger) => {
      this.localMerge = mergeMeshes(base, ours, theirs, { ...options, diff: { ...options.diff, logger }, logger });
      return mergeView(this.localMerge);
    });
  }

  /** Re-resolve the last merge with the COMPLETE set of resolutions (absent id = unresolved). */
  resolve(resolutions: Record<number, MergeResolution>, onLog: IEngineLog): Promise<IMergeView> {
    return this.call<IMergeView>({ type: 'resolve', resolutions }, onLog, (logger) => {
      if (!this.localMerge) throw new Error('no merge to resolve (run a merge first)');
      return mergeView(resolveMerge(this.localMerge, resolutions, { logger }));
    });
  }

  private call<T>(request: Request, onLog: IEngineLog, local: (logger: IDiffLogger) => T): Promise<T> {
    this.cancel();
    // A resolve must reach the engine that holds the merge: after a main-thread merge, stay here.
    if (request.type === 'resolve' && this.mode === 'main') return Promise.resolve(this.runHere(local, onLog));
    this.worker ??= this.spawn();
    const worker = this.worker;
    if (!worker) {
      this.mode = 'main';
      return Promise.resolve(this.runHere(local, onLog));
    }
    this.mode = 'worker';
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const detach = (): void => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const done = (): void => {
        detach();
        if (this.pending?.id === id) this.pending = null;
      };
      this.pending = { id, kind: request.type, reject, detach };
      const onMessage = (ev: MessageEvent<WorkerMessage>): void => {
        const msg = ev.data;
        if (msg.id !== id) return;
        if (msg.type === 'log') onLog(msg.level, msg.message);
        else if (msg.type === 'result' || msg.type === 'merged') {
          done();
          this.lastWindow = [msg.startedAt, msg.finishedAt];
          resolve((msg.type === 'result' ? msg.result : msg.view) as T);
        } else {
          done();
          const e = new Error(msg.message);
          if (msg.stack) e.stack = msg.stack;
          reject(e);
        }
      };
      const onError = (ev: ErrorEvent): void => {
        done();
        // A worker that fails to load (e.g. blocked module workers) must not break the viewer.
        this.worker?.terminate();
        this.worker = null;
        this.useWorker = false;
        try {
          this.mode = 'main';
          resolve(this.runHere(local, onLog));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(ev.message)));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  /** Main-thread fallback (records the same timing window as the worker path). */
  private runHere<T>(local: (logger: IDiffLogger) => T, onLog: IEngineLog): T {
    const start = performance.timeOrigin + performance.now();
    const result = local({ info: (m) => onLog('info', m), warn: (m) => onLog('warn', m), debug: (m) => onLog('debug', m) });
    this.lastWindow = [start, performance.timeOrigin + performance.now()];
    return result;
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }
}
