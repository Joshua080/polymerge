/**
 * The History panel (`polymerge log --view`, or a history page): the versions of one model,
 * newest first, with what each commit changed. Clicking a version shows what it changed against
 * the version before it, or against the one chosen under "Compare with".
 */
import type { IEmbedHistory } from 'polymerge-core';
import { h } from './dom.js';

export interface IHistorySelection {
  /** Index into versions (newest first). */
  selected: number;
  /** The version to compare with; null = the previous one that has a model. */
  compareTo: number | null;
}

const STATUS: Record<string, [mark: string, label: string, kind: string]> = {
  A: ['+', 'added', 'added'],
  D: ['−', 'deleted', 'removed'],
  R: ['→', 'renamed', 'modified'],
  W: ['●', 'uncommitted', 'modified'],
};

/** The previous (older) version with a model, before version `i`; null when there is none. */
export function previousModel(history: IEmbedHistory, i: number): number | null {
  for (let j = i + 1; j < history.versions.length; j++) if (history.versions[j].model !== null) return j;
  return null;
}

export function renderHistory(history: IEmbedHistory, sel: IHistorySelection, on: { select(i: number): void; compare(j: number | null): void }): HTMLElement[] {
  const versions = history.versions;
  const kindOf = (i: number): string => {
    const first = versions[i].summary[0] ?? '';
    if (first.startsWith('=')) return 'unchanged';
    if (first.startsWith('?')) return 'unreadable';
    return STATUS[versions[i].status]?.[2] ?? 'modified';
  };
  const list = h(
    'ol',
    { class: 'history-list', role: 'listbox', 'aria-label': 'Versions' },
    versions.map((v, i) => {
      const [mark] = STATUS[v.status] ?? ['~'];
      const item = h(
        'li',
        {
          class: `history-item${i === sel.selected ? ' selected' : ''}${i === sel.compareTo ? ' compared' : ''}`,
          role: 'option',
          'aria-selected': String(i === sel.selected),
          dataset: { index: String(i), kind: kindOf(i) },
          tabindex: i === sel.selected ? '0' : '-1',
          onclick: () => on.select(i),
        },
        h('span', { class: 'history-mark', 'aria-hidden': 'true' }, kindOf(i) === 'unchanged' ? '=' : mark),
        h(
          'span',
          { class: 'history-text' },
          h('span', { class: 'history-head' }, h('strong', null, v.short), ` ${v.date.slice(0, 10)}`, v.author ? ` · ${v.author}` : ''),
          h('span', { class: 'history-subject' }, v.subject),
          v.summary.length ? h('span', { class: 'history-summary', title: v.summary.join('\n') }, v.summary[0].replace(/^[~+−=?] /, '')) : null,
        ),
      );
      return item;
    }),
  );
  const compare = h(
    'select',
    { 'aria-label': 'Compare with', id: 'history-compare' },
    h('option', { value: '' }, 'the version before it'),
    versions.map((v, j) =>
      j > sel.selected && v.model !== null ? h('option', { value: String(j), selected: j === sel.compareTo }, `${v.short} · ${v.date.slice(0, 10)} · ${v.subject.slice(0, 40)}`) : null,
    ),
  );
  compare.addEventListener('change', () => on.compare(compare.value === '' ? null : Number(compare.value)));
  return [
    h('p', { class: 'muted small history-file' }, `${history.file} · ${versions.length} version${versions.length === 1 ? '' : 's'}, newest first`),
    list,
    h('div', { class: 'row history-compare' }, h('label', { class: 'small muted', for: 'history-compare' }, 'Compare with'), compare),
    h('p', { class: 'muted small' }, 'Click a version to see what it changed. [ and ] step older and newer.'),
  ];
}

/** Scroll the selected version into view inside the list. */
export function revealSelected(root: HTMLElement): void {
  root.querySelector<HTMLElement>('.history-item.selected')?.scrollIntoView({ block: 'nearest' });
}

