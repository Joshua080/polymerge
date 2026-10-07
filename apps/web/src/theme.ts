/**
 * Light or dark page. `?theme=dark` (or `light`) wins; otherwise this browser's last choice;
 * otherwise light. The page's colours are CSS variables keyed on `<html data-theme>`; the 3D
 * scene reads `sceneTheme()` and the viewer repaints itself when the theme changes.
 */
export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'polymerge.theme';

let current: ThemeName = 'light';
const listeners = new Set<(name: ThemeName) => void>();

export function themeName(): ThemeName {
  return current;
}

/** The colours the 3D scene draws with (sRGB hex). */
export interface ISceneTheme {
  /** Behind the model. */
  background: string;
  /** Triangle edges (wireframe layer). */
  wire: string;
  wireOpacity: number;
  /** Outlines on top of everything: the selected conflict, the selection line. */
  outline: string;
  /** Base / "old": the base ghost, the tail of displacement vectors, the "from" ring. */
  baseAccent: string;
  ghostOpacity: number;
  /** The section plane's cut outline and the measure line. */
  ink: string;
}

const SCENE: Record<ThemeName, ISceneTheme> = {
  light: { background: '#eceef1', wire: '#1f2328', wireOpacity: 0.35, outline: '#111418', baseAccent: '#4f86f7', ghostOpacity: 0.22, ink: '#111418' },
  dark: { background: '#1d1e21', wire: '#0b0c0e', wireOpacity: 0.5, outline: '#ffffff', baseAccent: '#93c5fd', ghostOpacity: 0.16, ink: '#f5f6f7' },
};

export function sceneTheme(name: ThemeName = current): ISceneTheme {
  return SCENE[name];
}

export function parseTheme(raw: string | null | undefined): ThemeName | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'light' || v === 'dark' ? v : null;
}

/** The theme to start with: the URL, then this browser's last choice, then light. */
export function initialTheme(params: URLSearchParams): ThemeName {
  const fromUrl = parseTheme(params.get('theme'));
  if (fromUrl) return fromUrl;
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY)) ?? 'light';
  } catch {
    return 'light'; // storage blocked (private window, sandboxed frame, file://)
  }
}

/** Make `name` current: the page's colours follow at once, the viewers on the next repaint. */
export function applyTheme(name: ThemeName): void {
  current = name;
  const root = document.documentElement;
  root.dataset.theme = name;
  root.style.colorScheme = name;
  root.style.setProperty('--pm-base', SCENE[name].baseAccent);
  for (const fn of listeners) fn(name);
}

/** Called after every theme change. Returns the unsubscribe function. */
export function onThemeChange(fn: (name: ThemeName) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function rememberTheme(name: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
