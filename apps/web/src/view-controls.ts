/** The two view settings both viewers offer: which axis is up, and the colour palette. */
import type { PaletteName } from 'polymerge-core';
import { h } from './dom.js';
import { paletteName, type UpAxis } from './view-options.js';

export interface IViewControls {
  root: HTMLElement;
  /** Show an up axis chosen elsewhere (the URL, or the default for STEP). */
  showUp(up: UpAxis): void;
}

export function viewControls(handlers: { onUp(up: UpAxis): void; onPalette(name: PaletteName): void }): IViewControls {
  const up = h(
    'select',
    { id: 'up-axis', 'aria-label': 'Up axis', title: 'Which axis of the model points up. CAD and 3D-printing files are usually Z up.' },
    h('option', { value: 'y' }, 'Y up'),
    h('option', { value: 'z' }, 'Z up (CAD)'),
  );
  const palette = h(
    'select',
    { id: 'palette', 'aria-label': 'Colours', title: 'Colour-blind safe: blue, orange and yellow instead of green, red and yellow' },
    h('option', { value: 'standard' }, 'Standard colours'),
    h('option', { value: 'colorblind' }, 'Colour-blind safe'),
  );
  palette.value = paletteName();
  up.addEventListener('change', () => handlers.onUp(up.value as UpAxis));
  palette.addEventListener('change', () => handlers.onPalette(palette.value as PaletteName));
  return {
    root: h('div', { class: 'row buttons view-options' }, up, palette),
    showUp(axis) {
      up.value = axis;
    },
  };
}
