/**
 * Self-contained pages (polymerge-core embed.ts): reading the diff a page carries, and writing a
 * new page from the one that is open — the viewer's own script and style (fetched when they are
 * files, read from the page when they are inline) with the current diff packed in.
 */
import { fromBase64, inlineFonts, packDiff, standaloneHtml, toBase64, unpackDiff, type IEmbeddedDiff } from 'polymerge-core';

/** The diff this page carries, if it is a self-contained page; throws when it is damaged. */
export function readEmbedded(): IEmbeddedDiff | null {
  const el = document.getElementById('polymerge-embed');
  if (!el) return null;
  return unpackDiff(fromBase64(el.textContent ?? ''));
}

export function isStandalonePage(): boolean {
  return document.getElementById('polymerge-embed') !== null;
}

/** The viewer's script and style sheet (fonts inlined: only the Latin subset, to keep pages small). */
async function viewerAssets(): Promise<{ script: string; style: string }> {
  const text = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not read ${url} (HTTP ${res.status})`);
    return res.text();
  };
  const moduleScript = document.querySelector<HTMLScriptElement>('script[type="module"]');
  if (!moduleScript) throw new Error('the viewer script is not in this page');
  const script = moduleScript.src ? await text(moduleScript.src) : (moduleScript.textContent ?? '');
  const styles: string[] = [];
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const css = await text(link.href);
    const fonts: Record<string, Uint8Array> = {};
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+\.woff2)\1\s*\)/g)) {
      if (!/inter-latin-wght/.test(m[2])) continue;
      const res = await fetch(new URL(m[2], link.href));
      if (res.ok) fonts[m[2]] = new Uint8Array(await res.arrayBuffer());
    }
    styles.push(inlineFonts(css, fonts));
  }
  // A self-contained page has its style inline already.
  if (styles.length === 0) for (const el of document.querySelectorAll('style')) styles.push(el.textContent ?? '');
  return { script, style: styles.join('\n') };
}

/** A self-contained page of `diff`, as HTML text. */
export async function standalonePage(diff: IEmbeddedDiff, title: string): Promise<string> {
  const { script, style } = await viewerAssets();
  return standaloneHtml({ title, script, style, payload: toBase64(packDiff(diff)), generator: diff.generator });
}
