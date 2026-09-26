/**
 * DiffEngine — runs diffMeshes in a Web Worker (one persistent module worker), falling back
 * to the main thread when workers are unavailable. A newer run supersedes an older one: the
 * busy worker is terminated (its CPU work is wasted anyway) and a fresh one is started.
 */
import { diffMeshes, type IDiffResult, type IMesh } from '@polymerge/core';
import type { IDiffRequest, WorkerDiffOptions, WorkerMessage } from './worker/protocol.js';

export type EngineMode = 'worker' | 'main';

export interface IEngineLog {
  (level: 'info' | 'warn' | 'debug', message: string): void;
}

export class DiffEngine {
  private worker: Worker | null = null;
  private busy = false;
  private nextId = 1;
  private pending: { id: number; reject: (e: Error) => void } | null = null;
  /** How the last diff actually ran. */
  mode: EngineMode = 'worker';

  private useWorker: boolean;

  constructor(useWorker = typeof Worker !== 'undefined') {
    this.useWorker = useWorker;
  }

  private spawn(): Worker | null {
    if (!this.useWorker) return null;
    try {
      return new Worker(new URL('./worker/diff.worker.ts', import.meta.url), { type: 'module', name: 'polymerge-diff' });
    } catch (err) {
      console.warn('[polymerge] could not start the diff worker; diffing on the main thread', err);
      return null;
    }
  }

  /** Cancel the running diff (if any): its promise rejects with an AbortError. */
  cancel(): void {
    if (this.pending) {
      const err = new Error('superseded by a newer diff');
      err.name = 'AbortError';
      this.pending.reject(err);
      this.pending = null;
    }
    if (this.worker && this.busy) {
      this.worker.terminate();
      this.worker = null;
      this.busy = false;
    }
  }

  run(base: IMesh, target: IMesh, options: WorkerDiffOptions, onLog: IEngineLog): Promise<IDiffResult> {
    this.cancel();
    this.worker ??= this.spawn();
    const worker = this.worker;
    if (!worker) {
      this.mode = 'main';
      return Promise.resolve(
        diffMeshes(base, target, {
          ...options,
          logger: { info: (m) => onLog('info', m), warn: (m) => onLog('warn', m), debug: (m) => onLog('debug', m) },
        }),
      );
    }
    this.mode = 'worker';
    const id = this.nextId++;
    return new Promise<IDiffResult>((resolve, reject) => {
      this.pending = { id, reject };
      this.busy = true;
      const done = (): void => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.busy = false;
        if (this.pending?.id === id) this.pending = null;
      };
      const onMessage = (ev: MessageEvent<WorkerMessage>): void => {
        const msg = ev.data;
        if (msg.id !== id) return;
        if (msg.type === 'log') onLog(msg.level, msg.message);
        else if (msg.type === 'result') {
          done();
          resolve(msg.result);
        } else {
          done();
          const e = new Error(msg.message);
          if (msg.stack) e.stack = msg.stack;
          reject(e);
        }
      };
      const onError = (ev: ErrorEvent): void => {
        done();
        // A worker that fails to load (e.g. blocked module workers) must not break diffing.
        this.worker?.terminate();
        this.worker = null;
        this.useWorker = false;
        try {
          this.mode = 'main';
          resolve(
            diffMeshes(base, target, {
              ...options,
              logger: { info: (m) => onLog('info', m), warn: (m) => onLog('warn', m), debug: (m) => onLog('debug', m) },
            }),
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(ev.message)));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      const req: IDiffRequest = { type: 'diff', id, base, target, options };
      worker.postMessage(req);
    });
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }
}
