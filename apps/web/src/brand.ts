/** The panel header both viewers share: the mark, the name, and the light / dark switch. */
import { h } from './dom.js';
import { applyTheme, onThemeChange, rememberTheme, themeName, type ThemeName } from './theme.js';
import { setUrlParam } from './view-options.js';

const SVG = 'http://www.w3.org/2000/svg';

function svg(viewBox: string, paths: { d: string; fill?: string; stroke?: string; opacity?: string }[]): SVGSVGElement {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  for (const p of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', p.d);
    path.setAttribute('fill', p.fill ?? 'none');
    if (p.stroke) {
      path.setAttribute('stroke', p.stroke);
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    if (p.opacity) path.setAttribute('opacity', p.opacity);
    el.append(path);
  }
  return el;
}

/** A cube: grey sides, the top in the "modified" colour — a model with a change. */
export function logoMark(): SVGSVGElement {
  return svg('0 0 32 32', [
    { d: 'M16 3 29 10v12L16 29 3 22V10z', fill: 'var(--pm-unchanged)' },
    { d: 'M16 17v12l13-7V10z', fill: 'var(--pm-unchanged)', opacity: '0.7' },
    { d: 'M16 3 29 10 16 17 3 10z', fill: 'var(--pm-modified)' },
  ]);
}

const SUN = [{ d: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', stroke: 'currentColor' }];
const MOON = [{ d: 'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z', stroke: 'currentColor' }];

/** Switches between the light and the dark theme; remembered in this browser. */
export function themeToggle(): HTMLButtonElement {
  const button = h('button', { class: 'icon theme-toggle', id: 'theme-toggle', type: 'button' });
  const show = (name: ThemeName) => {
    const next = name === 'light' ? 'dark' : 'light';
    button.replaceChildren(svg('0 0 24 24', name === 'light' ? MOON : SUN));
    button.title = `Switch to the ${next} theme`;
    button.setAttribute('aria-label', button.title);
  };
  button.addEventListener('click', () => {
    const next: ThemeName = themeName() === 'light' ? 'dark' : 'light';
    applyTheme(next);
    rememberTheme(next);
    setUrlParam('theme', null); // remembered in this browser instead
  });
  show(themeName());
  onThemeChange(show);
  return button;
}

/** The header: mark, name, what this page is, and the actions on the right. */
export function brandHeader(tagline: string, ...actions: HTMLElement[]): HTMLElement {
  return h(
    'header',
    { class: 'brand' },
    h('span', { class: 'logo' }, logoMark(), 'polymerge'),
    h('span', { class: 'tagline' }, tagline),
    h('span', { class: 'brand-actions' }, ...actions, themeToggle()),
  );
}
