import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { displayUnit, formatChange, formatMeasure, packPage, standaloneHtml, toBase64, type IEmbeddedPage, type IEmbedModel, type MetricUnit } from 'polymerge-core';
import { modelHistory, type IHistory, type IHistoryEntry, type IHistoryStep } from '../history.js';
import { formatSize, palette, point, type Palette } from '../report.js';
import { viewerAssets } from './export.js';
import { resolveWebDist, runView, viewParams, type ViewOptions } from './view.js';

export interface LogOptions {
  /** At most this many commits (default 20). */
  max?: string;
  json?: boolean;
  /** Leave out the uncommitted version. */
  committed?: boolean;
  /** Recompute instead of using the cache in the git directory. */
  noCache?: boolean;
  version: string;
  /** Open the history in the viewer. */
  view?: boolean;
  /** Write the history as one self-contained HTML page. */
  output?: string;
  viewer?: ViewOptions;
}

const PLAIN: Palette = { added: (s) => s, removed: (s) => s, modified: (s) => s, unchanged: (s) => s, bold: (s) => s, dim: (s) => s };

/** The history as a page payload: every readable version's model and the diff from the one before. */
export function historyPage(h: IHistory, generator: string, up?: 'y' | 'z'): IEmbeddedPage {
  const models: IEmbedModel[] = [];
  const index = h.meshes.map((mesh, i) => {
    if (!mesh) return null;
    models.push({ name: path.basename(h.entries[i].path), bytes: 0, mesh });
    return models.length - 1;
  });
  const results: IEmbeddedPage['results'] = [];
  h.results.forEach((result, i) => {
    if (result && index[i] !== null && index[i + 1] !== null && index[i + 1] !== undefined) results.push({ base: index[i + 1]!, target: index[i]!, result });
  });
  return {
    generator,
    view: up ? { up } : undefined,
    models,
    results,
    history: {
      file: h.rel,
      versions: h.entries.map((e, i) => ({
        commit: e.commit,
        short: e.short,
        author: e.author,
        date: e.date,
        subject: e.subject,
        status: e.status,
        path: e.path,
        from: e.from,
        summary: stepSummary(e.step, PLAIN).map((l) => l.trim()),
        model: index[i],
      })),
    },
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line for what a step did ("~ 46 vertices moved · volume +2.3 cm³ (+4%)"). */
export function stepSummary(s: IHistoryStep, c: Palette): string[] {
  if (s.kind === 'unreadable') return [c.dim(`? not compared: ${s.error ?? 'could not be read'}`)];
  if (s.kind === 'added' || s.kind === 'deleted') {
    const m = s.model!;
    const what = `${plural(m.faces, 'face')}, ${formatSize(m.size, m.unit)}${m.volume !== null ? `, volume ${formatMeasure(m.volume, 3, m.unit)}` : ''}`;
    return [s.kind === 'added' ? c.added(`+ added: ${what}`) : c.removed(`− deleted: ${what}`)];
  }
  if (s.kind === 'unchanged') return [c.dim('= no change to the model')];
  const unit: MetricUnit | undefined = s.metrics ? displayUnit(s.metrics) : undefined;
  const v = s.stats!.vertices;
  const parts: string[] = [];
  if (v.moved) parts.push(`${plural(v.moved, 'vertex').replace('vertexs', 'vertices')} moved (largest ${formatMeasure(s.stats!.maxDisplacement, 1, unit)})`);
  if (v.added) parts.push(`${v.added} added`);
  if (v.removed) parts.push(`${v.removed} removed`);
  if (parts.length === 0) parts.push('moved or turned as a whole');
  const m = s.metrics;
  if (m?.volume && m.volume.delta !== 0) parts.push(`volume ${formatChange(m.volume, 3, unit)}`);
  if (m) {
    const size = (['x', 'y', 'z'] as const)
      .map((axis, i) => (m.size[i].delta !== 0 ? `${axis} ${formatChange(m.size[i], 1, unit).replace(/ \(.*\)$/, '')}` : ''))
      .filter(Boolean);
    if (size.length) parts.push(`size ${size.join(', ')}`);
  }
  const out = [c.modified(`~ ${parts.join(' · ')}`)];
  for (const t of (s.cad ?? []).slice(0, 4)) out.push(`    ${t}`);
  if ((s.cad?.length ?? 0) > 4) out.push(c.dim(`    … ${s.cad!.length - 4} more CAD changes`));
  if (!s.cad?.length && s.regions?.length) {
    const r = s.regions[0];
    const more = s.regions.length > 1 ? c.dim(` (+${s.regions.length - 1} more)`) : '';
    out.push(c.dim(`    around ${point(r.center)}, ${formatSize(r.size, unit)}`) + more);
  }
  return out;
}

function header(e: IHistoryEntry, c: Palette): string {
  const date = e.date.slice(0, 10);
  const who = e.author ? `  ${e.author}` : '';
  const renamed = e.status === 'R' && e.from ? c.dim(`  (renamed from ${e.from})`) : '';
  return `${c.bold(e.short.padEnd(9))} ${date}${who}  ${e.subject}${renamed}`;
}

/** `polymerge log <file>`: what each commit did to the model, newest first. */
export async function runLog(file: string, o: LogOptions): Promise<number> {
  const max = o.max === undefined ? 20 : Math.max(1, Math.floor(Number(o.max)) || 20);
  const tty = process.stderr.isTTY && !o.json;
  const page = o.view || o.output !== undefined;
  if (page) {
    viewParams(o.viewer ?? {}); // a bad --up / --palette fails before the work
    resolveWebDist(o.viewer?.webDist);
  }
  const history = await modelHistory(
    file,
    {
      max,
      committedOnly: o.committed,
      cache: !o.noCache,
      engine: o.version,
      onStep: tty ? (done, total) => process.stderr.write(`\rReading version ${done} of ${total}…`) : undefined,
    },
    page,
  );
  if (tty) process.stderr.write('\r\x1b[K');
  if (page) {
    const up = o.viewer?.up?.toLowerCase();
    const packed = packPage(historyPage(history, `polymerge ${o.version}`, up === 'y' || up === 'z' ? up : undefined));
    if (o.output !== undefined) {
      const { script, style } = await viewerAssets(resolveWebDist(o.viewer?.webDist));
      const html = standaloneHtml({ title: `${path.basename(history.rel)} history · polymerge`, script, style, payload: toBase64(packed), generator: `polymerge ${o.version}` });
      await writeFile(o.output, html);
      const mb = Buffer.byteLength(html) / 1024 / 1024;
      process.stdout.write(`Wrote ${o.output} (${mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(mb * 1024))} KB`}): ${plural(history.entries.length, 'version')} of ${history.rel}. It opens in any browser, offline.\n`);
    }
    if (o.view) return runView([], o.viewer ?? {}, { history: '{models}/history.pmx' }, undefined, [{ name: 'history.pmx', bytes: packed, contentType: 'application/octet-stream' }]);
    return 0;
  }
  if (o.json) {
    process.stdout.write(JSON.stringify({ file: history.rel, versions: history.entries }, null, 2) + '\n');
    return 0;
  }
  const c = palette();
  const changes = history.entries.filter((e) => e.step.kind !== 'unchanged').length;
  const lines = [c.bold(`polymerge log  ${history.rel}`) + c.dim(`  (${plural(history.entries.length, 'version')}, ${plural(changes, 'change')}, newest first)`), ''];
  for (const e of history.entries) {
    lines.push(header(e, c));
    for (const l of stepSummary(e.step, c)) lines.push(`  ${l}`);
  }
  if (history.entries.filter((e) => e.status !== 'W').length >= max) lines.push('', c.dim(`Showing the last ${max} commits; --max <n> shows more.`));
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
