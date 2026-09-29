import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadMesh,
  mergeMeshes,
  writeMesh,
  WRITABLE_FORMATS,
  type IMergeResult,
  type MergeResolution,
  type SourceFormat,
} from 'polymerge-core';
import { loadMeshFile } from '../io.js';
import { fmt, palette, silentLogger, stderrLogger } from '../report.js';

export interface MergeCommandOptions {
  output?: string;
  format?: string;
  /** Resolution for every conflict: ours | theirs | base. */
  resolve?: string;
  /** Per-conflict resolutions: "<id>=ours|theirs|base". */
  pick?: string[];
  report?: string;
  quiet?: boolean;
  /** Check the combined edits for collisions (default true; --no-collision-check). */
  collisionCheck?: boolean;
}

const RESOLUTIONS: readonly MergeResolution[] = ['ours', 'theirs', 'base'];

function parseResolution(flag: string, raw: string): MergeResolution {
  if (!(RESOLUTIONS as readonly string[]).includes(raw)) throw new Error(`${flag} must be ours, theirs or base (got "${raw}")`);
  return raw as MergeResolution;
}

export function parsePicks(picks: string[] = []): Record<number, MergeResolution> {
  const out: Record<number, MergeResolution> = {};
  for (const p of picks) {
    const m = /^(\d+)=(\w+)$/.exec(p);
    if (!m) throw new Error(`--pick expects <conflict id>=ours|theirs|base (got "${p}")`);
    out[Number(m[1])] = parseResolution('--pick', m[2]);
  }
  return out;
}

/** Output format from an explicit flag or the file extension; only writable formats. */
export function outputFormat(file: string, explicit?: string): SourceFormat {
  const f = (explicit ?? path.extname(file).slice(1)).toLowerCase();
  if (!(WRITABLE_FORMATS as readonly string[]).includes(f)) {
    throw new Error(`cannot write "${f || '(no extension)'}" files yet — supported: ${WRITABLE_FORMATS.join(', ')}`);
  }
  return f as SourceFormat;
}

export function formatMergeReport(r: IMergeResult, names: { base: string; ours: string; theirs: string }): string {
  const c = palette();
  const s = r.stats;
  const out: string[] = [c.bold('polymerge merge')];
  out.push(`  base    ${names.base}`);
  out.push(`  ours    ${names.ours}  ${c.dim(`(Tier ${r.ours.tier})`)}`);
  out.push(`  theirs  ${names.theirs}  ${c.dim(`(Tier ${r.theirs.tier})`)}`);
  const u = r.frame.transform.units;
  const frameText: Record<IMergeResult['frame']['source'], string> = {
    base: 'base frame',
    ours: 'from ours',
    theirs: 'from theirs',
    both: 'identical on both sides',
    composed: 'unit conversion composed with the other side’s whole-model move',
    conflict: 'CONFLICT (see below)',
  };
  out.push(`${c.bold('Frame')}      ${frameText[r.frame.source]}${u ? ` — units ${u.from} → ${u.to} (×${Number(u.factor.toPrecision(6))})` : ''}`);
  const side = (moved: number, deleted: number, faces: number, parts: number): string =>
    `${moved} moved vertex(es), ${deleted} deletion(s), ${faces} new face(s)${parts ? `, ${parts} part motion(s)` : ''}`;
  out.push(`${c.bold('Applied')}    ours: ${side(s.movedFromOurs, s.deletedFromOurs, s.facesAddedFromOurs, s.partMotionsFromOurs)}`);
  out.push(`           theirs: ${side(s.movedFromTheirs, s.deletedFromTheirs, s.facesAddedFromTheirs, s.partMotionsFromTheirs)}`);
  out.push(`           identical on both: ${s.movedConvergent + s.deletedConvergent + s.facesAddedConvergent} change(s)`);
  if (r.conflicts.length > 0) {
    out.push(c.bold(`Conflicts (${r.conflicts.length}):`));
    for (const k of r.conflicts) {
      const where = k.wholeModel ? 'whole model' : `${k.baseVertices.length} base vertex(es) near (${k.focus.map((x) => fmt(x, 3)).join(', ')})`;
      const state = k.resolution ? c.added(`→ ${k.resolution}`) : c.removed('unresolved (base kept)');
      out.push(`  ${c.removed(`#${k.id}`)} [${Object.keys(k.kinds).join(', ')}] ${k.message}`);
      out.push(`      ${c.dim(where)}  ${state}`);
    }
  }
  for (const w of r.warnings) out.push(c.modified(`WARNING: ${w.message}`));
  out.push(
    r.clean
      ? c.added(`Result: clean — ${r.merged.vertexCount} vertices · ${r.merged.faceCount} faces`)
      : c.removed(
          `Result: ${s.unresolved} unresolved conflict(s) — those regions keep the BASE geometry. ` +
            `Resolve with --resolve ours|theirs or --pick <id>=ours|theirs.`,
        ),
  );
  return out.join('\n');
}

/** JSON-safe report (typed arrays → arrays). */
export function mergeReportJson(r: IMergeResult): string {
  return JSON.stringify(
    {
      clean: r.clean,
      tiers: { ours: r.ours.tier, theirs: r.theirs.tier },
      frame: r.frame,
      stats: r.stats,
      conflicts: r.conflicts.map((c) => ({
        ...c,
        baseVertices: Array.from(c.baseVertices),
        baseFaces: Array.from(c.baseFaces),
        oursVertices: Array.from(c.oursVertices),
        theirsVertices: Array.from(c.theirsVertices),
      })),
      warnings: r.warnings.map((w) => ({ ...w, mergedFaces: Array.from(w.mergedFaces) })),
      merged: { vertices: r.merged.vertexCount, faces: r.merged.faceCount },
    },
    null,
    2,
  );
}

/** `polymerge merge <base> <ours> <theirs>` — returns 0 when clean, 1 with unresolved conflicts. */
export async function runMerge(basePath: string, oursPath: string, theirsPath: string, o: MergeCommandOptions): Promise<number> {
  const format = o.output ? outputFormat(o.output, o.format) : undefined;
  const [base, ours, theirs] = await Promise.all([loadMeshFile(basePath), loadMeshFile(oursPath), loadMeshFile(theirsPath)]);
  const result = mergeMeshes(base.mesh, ours.mesh, theirs.mesh, {
    logger: o.quiet ? silentLogger : stderrLogger(false),
    defaultResolution: o.resolve ? parseResolution('--resolve', o.resolve) : null,
    resolutions: parsePicks(o.pick),
    detectCollisions: o.collisionCheck !== false,
  });
  if (o.output && format) await writeFile(o.output, writeMesh(result.merged, format, { name: path.basename(o.output) }));
  if (o.report) await writeFile(o.report, mergeReportJson(result));
  if (!o.quiet) {
    process.stdout.write(formatMergeReport(result, { base: base.fileName, ours: ours.fileName, theirs: theirs.fileName }) + '\n');
    if (o.output) process.stdout.write(`Wrote ${o.output}\n`);
  }
  return result.clean ? 0 : 1;
}

/**
 * git merge driver (merge.<name>.driver = "polymerge git-merge %O %A %B %P"):
 * merges ancestor %O, current %A and other %B, writes the result over %A in the format of
 * path %P (STL, OBJ, GLB or .gltf; glTF keeps the inputs' nodes), prints a summary to stderr
 * and exits 0 (clean) or 1 (conflicts left in base state, git marks the file as conflicted).
 * With --resolve, a combination that damages the model (a collision warning) also exits 1:
 * an automatic merge must never commit it unseen.
 * Unwritable formats exit 2 without touching %A.
 */
export async function runGitMerge(args: string[], o: { resolve?: string; collisionCheck?: boolean } = {}): Promise<number> {
  if (args.length < 4) {
    process.stderr.write('polymerge git-merge: expected %O %A %B %P from git\n');
    return 2;
  }
  const [ancestor, current, other, repoPath] = args;
  let format: SourceFormat;
  try {
    format = outputFormat(repoPath);
  } catch (err) {
    process.stderr.write(`polymerge git-merge: ${repoPath}: ${(err as Error).message}; leaving the file for manual merging\n`);
    return 2;
  }
  const [base, ours, theirs] = await Promise.all([
    loadMeshFile(ancestor, repoPath),
    loadMeshFile(current, repoPath),
    loadMeshFile(other, repoPath),
  ]);
  const result = mergeMeshes(base.mesh, ours.mesh, theirs.mesh, {
    logger: silentLogger,
    defaultResolution: o.resolve ? parseResolution('--resolve', o.resolve) : null,
    detectCollisions: o.collisionCheck !== false,
  });
  await writeFile(current, writeMesh(result.merged, format, { name: path.basename(repoPath) }));
  process.stderr.write(formatMergeReport(result, { base: `${repoPath} (ancestor)`, ours: `${repoPath} (ours)`, theirs: `${repoPath} (theirs)` }) + '\n');
  return result.clean && result.warnings.length === 0 ? 0 : 1;
}

/**
 * `polymerge resolve <path>` — finish a conflicted git merge of a model: reads the three
 * index stages git keeps for a conflicted file (:1 ancestor, :2 ours, :3 theirs), merges them
 * with the given resolutions and writes the result to <path>. Exit 0 when nothing is left
 * unresolved (then `git add <path>` to mark it resolved).
 */
export async function runGitResolve(repoPath: string, o: MergeCommandOptions): Promise<number> {
  const { result, bytes } = await resolveStages((n) => gitStage(n, repoPath), repoPath, o);
  await writeFile(repoPath, bytes);
  if (!o.quiet) {
    process.stdout.write(formatMergeReport(result, { base: `${repoPath} :1`, ours: `${repoPath} :2 (ours)`, theirs: `${repoPath} :3 (theirs)` }) + '\n');
    process.stdout.write(result.clean ? `Wrote ${repoPath} — run "git add ${repoPath}" to mark it resolved.\n` : `Wrote ${repoPath} (still conflicted).\n`);
  }
  return result.clean ? 0 : 1;
}

/**
 * What `polymerge resolve` computes: the three index stages of a conflicted file merged with
 * the given resolutions, and the bytes it writes to <path> (format from its extension). The
 * merge review's "Save to repository" (write-back.ts) calls this too, so a save from the
 * browser writes exactly what `polymerge resolve <path> --pick …` would.
 */
export async function resolveStages(
  stage: (n: 1 | 2 | 3) => Uint8Array,
  repoPath: string,
  o: MergeCommandOptions,
): Promise<{ result: IMergeResult; bytes: Uint8Array }> {
  const format = outputFormat(repoPath, o.format);
  const load = (n: 1 | 2 | 3) => loadMesh(new Uint8Array(stage(n)), { fileName: path.basename(repoPath) });
  const [base, ours, theirs] = await Promise.all([load(1), load(2), load(3)]);
  const result = mergeMeshes(base, ours, theirs, {
    logger: silentLogger,
    defaultResolution: o.resolve ? parseResolution('--resolve', o.resolve) : null,
    resolutions: parsePicks(o.pick),
    detectCollisions: o.collisionCheck !== false,
  });
  return { result, bytes: writeMesh(result.merged, format, { name: path.basename(repoPath) }) };
}

/**
 * One index stage of a conflicted file: 1 = common ancestor, 2 = ours, 3 = theirs. `repoPath`
 * is relative to `cwd` (or absolute), as the user typed it. `git show :n:<path>` reads a bare
 * path from the repository root, so it is anchored with ./ to mean "from here".
 */
export function gitStage(n: 1 | 2 | 3, repoPath: string, cwd = process.cwd()): Buffer {
  const rel = (path.isAbsolute(repoPath) ? path.relative(cwd, repoPath) : repoPath).split(path.sep).join('/');
  const anchored = rel === '..' || rel.startsWith('./') || rel.startsWith('../') ? rel : `./${rel}`;
  try {
    return execFileSync('git', ['show', `:${n}:${anchored}`], { cwd, maxBuffer: 1 << 30 });
  } catch {
    throw new Error(`git has no stage ${n} for ${repoPath} — is it an unresolved merge conflict? (git status)`);
  }
}
