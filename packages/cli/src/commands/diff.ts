import { writeFile } from 'node:fs/promises';
import { diffMeshes, serializeDiff, type IDiffOptions, type MatchTier } from 'polymerge-core';
import { loadMeshFile } from '../io.js';
import { formatDiffReport, hasChanges, silentLogger, stderrLogger } from '../report.js';

export interface DiffCommandOptions {
  json?: string;
  forceTier?: string;
  moveEpsilon?: string;
  surfaceTolerance?: string;
  top?: string;
  quiet?: boolean;
  verbose?: boolean;
  exitCode?: boolean;
}

export function parseDiffOptions(o: DiffCommandOptions, quiet: boolean): IDiffOptions {
  const opts: IDiffOptions = { logger: quiet ? silentLogger : stderrLogger(o.verbose === true) };
  if (o.forceTier !== undefined) {
    const t = Number(o.forceTier);
    if (t !== 1 && t !== 2 && t !== 3) throw new Error(`--force-tier must be 1, 2 or 3 (got "${o.forceTier}")`);
    opts.forceTier = t as MatchTier;
  }
  if (o.moveEpsilon !== undefined) opts.moveEpsilon = positiveNumber('--move-eps', o.moveEpsilon);
  if (o.surfaceTolerance !== undefined) opts.surfaceTolerance = positiveNumber('--surface-tol', o.surfaceTolerance);
  return opts;
}

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number (got "${raw}")`);
  return n;
}

/** `polymerge diff <base> <target>` — returns the process exit code. */
export async function runDiff(basePath: string, targetPath: string, o: DiffCommandOptions): Promise<number> {
  const jsonToStdout = o.json === '-';
  const quiet = o.quiet === true;
  const [base, target] = await Promise.all([loadMeshFile(basePath), loadMeshFile(targetPath)]);
  const result = diffMeshes(base.mesh, target.mesh, parseDiffOptions(o, quiet));

  if (o.json !== undefined) {
    const json = serializeDiff(result);
    if (jsonToStdout) process.stdout.write(json + '\n');
    else await writeFile(o.json, json);
  }
  if (!jsonToStdout && !quiet) {
    const top = o.top === undefined ? 10 : Math.max(0, Math.floor(Number(o.top)) || 0);
    process.stdout.write(
      formatDiffReport(result, base.mesh, target.mesh, { baseName: base.fileName, targetName: target.fileName, topMoves: top }) + '\n',
    );
    if (o.json !== undefined) process.stdout.write(`Wrote ${o.json}\n`);
  }
  return o.exitCode && hasChanges(result) ? 1 : 0;
}
