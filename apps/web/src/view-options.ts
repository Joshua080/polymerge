/**
 * How models are shown, independent of what they are: the colour palette and which model axis
 * points up.
 *
 * - Palette: `?palette=colorblind` (or `standard`) wins; otherwise the viewer's last choice in
 *   this browser; otherwise standard. DOM swatches use the CSS variables below, so a switch
 *   repaints every legend at once; the 3D layers read `diffColors()` / `mergeColors()` when they
 *   are built, and the viewer rebuilds them (DiffViewer.setPalette).
 * - Up axis: `?up=z` (or `y`) wins; otherwise Z when a model is STEP (the CAD convention),
 *   else Y (three.js and glTF). STL and OBJ carry no convention, so they keep Y and the toggle
 *   is one click away.
 */
import { DIFF_PALETTES, MERGE_PALETTES, PALETTE_NAMES, type PaletteName, type SourceFormat } from 'polymerge-core';

export type UpAxis = 'y' | 'z';

const STORAGE_KEY = 'polymerge.palette';

let current: PaletteName = 'standard';

export function paletteName(): PaletteName {
  return current;
}

/** The current diff colours, sRGB hex (for three.js). */
export function diffColors(): Readonly<Record<keyof (typeof DIFF_PALETTES)['standard'], string>> {
  return DIFF_PALETTES[current];
}

/** The current merge colours, sRGB hex (for three.js). */
export function mergeColors(): Readonly<Record<keyof (typeof MERGE_PALETTES)['standard'], string>> {
  return MERGE_PALETTES[current];
}

/** The same colours for the DOM: CSS variables that follow the palette. */
export const DIFF_CSS = {
  added: 'var(--pm-added)',
  removed: 'var(--pm-removed)',
  modified: 'var(--pm-modified)',
  unchanged: 'var(--pm-unchanged)',
} as const;

export const MERGE_CSS = {
  unchanged: 'var(--pm-merge-unchanged)',
  ours: 'var(--pm-ours)',
  theirs: 'var(--pm-theirs)',
  both: 'var(--pm-both)',
  conflict: 'var(--pm-conflict)',
} as const;

/** Make `name` current and repaint the DOM's CSS variables. */
export function applyPalette(name: PaletteName): void {
  current = name;
  const d = DIFF_PALETTES[name];
  const m = MERGE_PALETTES[name];
  const vars: Record<string, string> = {
    '--pm-added': d.added,
    '--pm-removed': d.removed,
    '--pm-modified': d.modified,
    '--pm-unchanged': d.unchanged,
    '--pm-merge-unchanged': m.unchanged,
    '--pm-ours': m.ours,
    '--pm-theirs': m.theirs,
    '--pm-both': m.both,
    '--pm-conflict': m.conflict,
  };
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  document.documentElement.dataset.palette = name;
}

export function parsePalette(raw: string | null | undefined): PaletteName | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'cb' || v === 'colourblind' || v === 'color-blind' || v === 'colour-blind') return 'colorblind';
  return (PALETTE_NAMES as readonly string[]).includes(v) ? (v as PaletteName) : null;
}

/** The palette to start with: the URL, then this browser's last choice, then standard. */
export function initialPalette(params: URLSearchParams): PaletteName {
  const fromUrl = parsePalette(params.get('palette'));
  if (fromUrl) return fromUrl;
  try {
    return parsePalette(localStorage.getItem(STORAGE_KEY)) ?? 'standard';
  } catch {
    return 'standard'; // storage blocked (private window, sandboxed frame)
  }
}

/** Remember a choice the viewer made, for next time in this browser. */
export function rememberPalette(name: PaletteName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function parseUpAxis(raw: string | null | undefined): UpAxis | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'y' || v === 'z' ? v : null;
}

/** The up axis for these models when the URL does not say: Z for STEP, Y otherwise. */
export function defaultUpAxis(formats: (SourceFormat | undefined)[]): UpAxis {
  return formats.includes('step') ? 'z' : 'y';
}

/** Set one query parameter in the address bar (null removes it), without reloading. */
export function setUrlParam(key: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  if (url.href !== window.location.href) history.replaceState(null, '', url);
}
