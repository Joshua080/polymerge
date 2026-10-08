import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diffMeshes, inlineFonts, packDiff, standaloneHtml, toBase64, type IDiffResult } from 'polymerge-core';
import { loadMeshPair } from '../io.js';
import { parseDiffOptions, type DiffCommandOptions } from './diff.js';
import { resolveWebDist } from './view.js';

export interface ExportOptions extends Pick<DiffCommandOptions, 'forceTier' | 'moveEpsilon' | 'surfaceTolerance' | 'quiet' | 'verbose'> {
  /** Where to write the page (default: <old>__<new>.html in the current directory). */
  output?: string;
  /** Which axis of the models is up when the page opens (default: Z for STEP, else Y). */
  up?: string;
  webDist?: string;
  /** The polymerge version, for the page's generator line. */
  version: string;
}

/** The attributes of the first tag of `tag` in `html` whose attributes satisfy `test`. */
function findTag(html: string, tag: string, test: (a: Record<string, string>) => boolean): Record<string, string> | null {
  for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] ?? '';
    if (test(attrs)) return attrs;
  }
  return null;
}

/** The viewer's script and style sheet, read from a built viewer, with its Latin font inlined. */
export async function viewerAssets(webDist: string): Promise<{ script: string; style: string }> {
  const index = await readFile(path.join(webDist, 'index.html'), 'utf8');
  const script = findTag(index, 'script', (a) => a.type === 'module' && !!a.src);
  const link = findTag(index, 'link', (a) => a.rel === 'stylesheet' && !!a.href);
  if (!script || !link) throw new Error(`${path.join(webDist, 'index.html')} does not look like the built viewer (no module script or style sheet)`);
  const file = (rel: string) => path.join(webDist, rel.replace(/^\.?\//, ''));
  const cssPath = file(link.href);
  const css = await readFile(cssPath, 'utf8');
  const fonts: Record<string, Uint8Array> = {};
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+\.woff2)\1\s*\)/g)) {
    if (/inter-latin-wght/.test(m[2])) fonts[m[2]] = new Uint8Array(await readFile(path.resolve(path.dirname(cssPath), m[2])));
  }
  return { script: await readFile(file(script.src), 'utf8'), style: inlineFonts(css, fonts) };
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function changeText(r: IDiffResult): string {
  const v = r.stats.vertices;
  const parts = [v.moved && `${v.moved} moved`, v.added && `${v.added} added`, v.removed && `${v.removed} removed`].filter(Boolean);
  return `Tier ${r.tier}, ${parts.length > 0 ? `vertices ${parts.join(', ')}` : 'no changes'}`;
}

/** `polymerge export <old> <new> [-o page.html]`: the diff and the viewer in one HTML file. */
export async function runExport(basePath: string, targetPath: string, o: ExportOptions): Promise<number> {
  const quiet = o.quiet === true;
  if (o.up !== undefined && o.up !== 'y' && o.up !== 'z') throw new Error(`--up must be y or z (got "${o.up}")`);
  const webDist = resolveWebDist(o.webDist); // before the work: a missing viewer fails fast
  const [base, target] = await loadMeshPair({ path: basePath }, { path: targetPath });
  const result = diffMeshes(base.mesh, target.mesh, parseDiffOptions(o, quiet));
  const generator = `polymerge ${o.version}`;
  const payload = toBase64(
    packDiff({
      generator,
      base: { name: base.fileName, bytes: base.bytes.byteLength, mesh: base.mesh },
      target: { name: target.fileName, bytes: target.bytes.byteLength, mesh: target.mesh },
      result,
      view: o.up ? { up: o.up } : undefined,
    }),
  );
  const { script, style } = await viewerAssets(webDist);
  const html = standaloneHtml({ title: `${base.fileName} → ${target.fileName} · polymerge`, script, style, payload, generator });
  const stem = (name: string) => name.replace(/\.[^.]+$/, '');
  const out = o.output ?? `${stem(base.fileName)}__${stem(target.fileName)}.html`;
  await writeFile(out, html);
  if (!quiet) {
    process.stdout.write(
      `Wrote ${out} (${sizeText(Buffer.byteLength(html))}): ${base.fileName} → ${target.fileName}, ${changeText(result)}.\n` +
        'It opens in any browser, offline, with nothing to install: email it or attach it to a ticket.\n',
    );
  }
  return 0;
}
