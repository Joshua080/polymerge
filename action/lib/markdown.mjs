/**
 * The pull-request comment, built from a VALIDATED render result (lib/validate.mjs). Pure;
 * unit-tested in action/test/markdown.test.ts.
 *
 * Every string that came from the pull request (file paths, part names, parser messages) is
 * untrusted. It only ever appears inside a markdown code span (codeSpan), never as markdown or
 * HTML: code spans are not parsed for emphasis, links, HTML or @mentions. Invisible and
 * direction-changing characters are shown as visible escapes, so a name cannot hide or reorder
 * text. The explanatory wording (hints, labels) is fixed text from this file, never from the
 * result.
 */

/** The hidden first line that identifies polymerge's comment on a pull request. */
export const MARKER = '<!-- polymerge:pr-diff -->';
export const PROJECT_URL = 'https://github.com/Joshua080/polymerge';
export const RUN_COMMAND = 'npx @joshuahurley/polymerge';
/** STEP needs OpenCascade, an optional download (occt-import-js, LGPL-2.1): npx fetches it alongside. */
export const RUN_COMMAND_STEP = 'npx -p @joshuahurley/polymerge -p occt-import-js@0.0.23 polymerge';

/** GitHub rejects comments over 65,536 characters; stay well below. */
export const MAX_BODY = 60_000;

/** The tier names of polymerge-core's TIER_NAMES, without the "Tier n ·" prefix (checked by a test). */
export const TIER_LABELS = {
  1: 'index/ID (direct lineage)',
  2: 'topological (geometric + adjacency)',
  3: 'point cloud (ICP + nearest surface)',
};

/** Status squares per palette (the `palette` input): they match the image's colours. */
const COLORS = {
  standard: { moved: '🟨', added: '🟩', removed: '🟥', warn: '⚠️' },
  colorblind: { moved: '🟨', added: '🟦', removed: '🟧', warn: '⚠️' },
};
const COLOR = COLORS.standard;

/** Control, invisible and bidirectional-override characters, as code point ranges. */
const HIDDEN_RANGES = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfffb],
];
const HIDDEN_CLASS = `[${HIDDEN_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`;
const HIDDEN = new RegExp(HIDDEN_CLASS, 'gu');

/**
 * Untrusted text made visible and short: hidden characters become escapes (`\n`, `\u{202e}`), and
 * long text keeps its end (for a path, the file name) behind an ellipsis.
 */
export function visible(value, max = 160) {
  const escaped = String(value).replace(HIDDEN, (c) =>
    c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );
  const chars = [...escaped];
  return chars.length > max ? `…${chars.slice(chars.length - (max - 1)).join('')}` : escaped;
}

/**
 * Untrusted text as an inline code span. The backtick fence is longer than any backtick run in the
 * text; inside a table, pipes are escaped (GFM splits table cells before parsing code spans).
 */
export function codeSpan(value, { table = false, max = 160 } = {}) {
  let t = visible(value, max);
  if (table) t = t.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** An argument for a POSIX shell command line, or null when it holds characters a copied command must not carry. */
export function shellQuote(value) {
  const s = String(value);
  if (s === '' || new RegExp(HIDDEN_CLASS, 'u').test(s)) return null;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Attribute-safe text for our own HTML (alt text). */
function attr(value) {
  return visible(value, 200).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const int = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const short = (sha) => `\`${sha.slice(0, 7)}\``;

/** A length or angle with 3 significant digits (no exponent for everyday magnitudes). */
function num(x) {
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-3) return x.toExponential(2);
  return String(Number(x.toPrecision(3)));
}

function transformText(t) {
  const parts = [];
  if (t.units) parts.push(`units ${t.units.from} → ${t.units.to} (×${num(t.units.factor)})`);
  else if (Math.abs(t.scale - 1) > 1e-9) parts.push(`scaled ×${num(t.scale)}`);
  if (t.rotationDeg > 0.01) parts.push(`turned ${num(t.rotationDeg)}°`);
  if (t.distance > 0) parts.push(`moved ${num(t.distance)}`);
  return parts.join(', ') || 'moved';
}

/** The few facts that best say what changed, for the table. */
function changeFacts(d) {
  const facts = [];
  if (d.partsTotal > 0) facts.push(`${plural(d.partsTotal, 'part')} moved`);
  if (d.vertices.moved > 0) facts.push(`${plural(d.vertices.moved, 'vertex', 'vertices')} moved`);
  if (d.faces.added > 0) facts.push(`${plural(d.faces.added, 'face')} added`);
  if (d.faces.removed > 0) facts.push(`${plural(d.faces.removed, 'face')} removed`);
  if (d.transform) facts.push(`whole model ${transformText(d.transform)}`);
  return facts.slice(0, 3).join(' · ') || 'no local change';
}

function fileCell(f) {
  return f.oldPath ? `${codeSpan(f.oldPath, { table: true })} → ${codeSpan(f.path, { table: true })}` : codeSpan(f.path, { table: true });
}

function statusCell(f, limits, C = COLOR) {
  const faces = (side) => (f.mesh[side] ? ` · ${plural(f.mesh[side].faces, 'face')}` : '');
  switch (f.status) {
    case 'rendered':
    case 'render-failed': {
      const warn = f.status === 'render-failed' ? `${C.warn} image failed · ` : '';
      if (f.change === 'added') return `${warn || `${C.added} `}added${faces('after')}`;
      if (f.change === 'deleted') return `${warn || `${C.removed} `}deleted${faces('before')}`;
      return `${warn || `${C.moved} `}${f.change === 'renamed' ? 'renamed · ' : ''}${f.diff ? changeFacts(f.diff) : 'changed'}`;
    }
    case 'same-content':
      return f.change === 'renamed' ? 'renamed, content unchanged' : f.modeChanged ? 'file mode changed, content unchanged' : 'content unchanged';
    case 'same-geometry':
      return f.diff?.transform ? `whole model ${transformText(f.diff.transform)}, no local change` : 'same geometry (re-exported or re-ordered)';
    case 'error':
      return `${COLOR.warn} could not be read`;
    case 'lfs':
      return `${COLOR.warn} Git LFS file, not fetched`;
    case 'too-large':
      return `${COLOR.warn} too large to render${f.limit ? ` (${int(f.limit.value)} ${f.limit.what === 'faces' ? 'faces' : 'bytes'}; limit ${int(f.limit.max)})` : ''}`;
    case 'not-rendered':
      return `not rendered: over the limit of ${plural(limits.maxFiles, 'model')} per comment`;
    case 'skipped':
      return 'symbolic link, not rendered';
    default:
      return '';
  }
}

/** Notes that explain problem rows; fixed wording plus the file (and the parser's message). */
function notes(files, limits) {
  const out = [];
  const lfs = files.filter((f) => f.status === 'lfs');
  if (lfs.length > 0) {
    out.push(
      `- ${COLOR.warn} ${lfs.slice(0, 5).map((f) => codeSpan(f.path)).join(', ')}${lfs.length > 5 ? ` and ${int(lfs.length - 5)} more` : ''} ${lfs.length === 1 ? 'is' : 'are'} stored in **Git LFS**, and the workflow checked out only the pointer ${lfs.length === 1 ? 'file' : 'files'}. Add \`lfs: true\` to the \`actions/checkout\` step to render ${lfs.length === 1 ? 'it' : 'them'}.`,
    );
  }
  for (const f of files.filter((x) => x.status === 'error' || x.status === 'render-failed').slice(0, 10)) {
    const what = f.status === 'error' ? 'could not be read as a model' : 'was diffed, but its image could not be rendered';
    out.push(`- ${COLOR.warn} ${codeSpan(f.path)} ${what}${f.error ? `: ${codeSpan(f.error, { max: 300 })}` : '.'}`);
  }
  if (files.some((f) => f.status === 'too-large')) {
    out.push(`- Models above ${plural(limits.maxFaces, 'face')} or ${int(Math.round(limits.maxBytes / 1024 / 1024))} MB are not rendered (the \`max-triangles\` and \`max-file-size\` inputs).`);
  }
  if (files.some((f) => f.status === 'not-rendered')) {
    out.push(`- At most ${plural(limits.maxFiles, 'model')} ${limits.maxFiles === 1 ? 'is' : 'are'} rendered per comment (the \`max-files\` input).`);
  }
  return out;
}

function section(f, imageUrl) {
  const lines = [];
  const title = f.oldPath ? `${codeSpan(f.oldPath)} → ${codeSpan(f.path)}` : codeSpan(f.path);
  lines.push(`#### ${title}`, '');
  const url = f.image ? imageUrl(f.image) : null;
  if (url) {
    const what = f.change === 'added' ? 'After' : f.change === 'deleted' ? 'Before' : 'Before and after';
    lines.push(`<img src="${attr(url)}" width="800" alt="${what}: ${attr(f.path)}">`, '');
  }
  const d = f.diff;
  if (f.change === 'added' && f.mesh.after) lines.push(`- **New model** ${plural(f.mesh.after.vertices, 'vertex', 'vertices')} · ${plural(f.mesh.after.faces, 'face')}`);
  if (f.change === 'deleted' && f.mesh.before) lines.push(`- **Deleted model** had ${plural(f.mesh.before.vertices, 'vertex', 'vertices')} · ${plural(f.mesh.before.faces, 'face')}`);
  if (d) {
    if (d.partsTotal > 0) {
      const named = d.parts.map((p) => `${p.name ? `${codeSpan(p.name, { max: 60 })} ` : ''}moved ${num(p.distance)}${p.rotationDeg > 0.01 ? `, turned ${num(p.rotationDeg)}°` : ''}`);
      const more = d.partsTotal - d.parts.length;
      lines.push(`- **${d.partsTotal === 1 ? 'Moved part' : `${int(d.partsTotal)} moved parts`}** ${named.join('; ')}${more > 0 ? `; ${int(more)} more` : ''}`);
    }
    const v = d.vertices;
    const fc = d.faces;
    lines.push(`- **Vertices** ${int(v.moved)} moved · ${int(v.added)} added · ${int(v.removed)} removed (${int(v.before)} → ${int(v.after)})`);
    lines.push(`- **Faces** ${int(fc.modified)} modified · ${int(fc.added)} added · ${int(fc.removed)} removed (${int(fc.before)} → ${int(fc.after)})`);
    if (d.transform) lines.push(`- **Whole model** ${transformText(d.transform)}; the before image is aligned to the after`);
    const largest = d.maxDisplacement > 0 ? ` Largest vertex move ${num(d.maxDisplacement)}.` : '';
    lines.push('', `<sub>Matched by Tier ${d.tier} · ${TIER_LABELS[d.tier]}.${largest}</sub>`);
  }
  return lines;
}

function exploreBlock(result, files) {
  const groups = [];
  for (const f of files) {
    if (!f.mesh.before || !f.mesh.after || groups.length >= 3) continue;
    const ext = (/\.([A-Za-z0-9]+)$/.exec(f.path)?.[1] ?? 'stl').toLowerCase();
    const before = shellQuote(`${result.base.slice(0, 12)}:${f.oldPath ?? f.path}`);
    const after = shellQuote(`${result.head.slice(0, 12)}:${f.path}`);
    if (!before || !after) continue;
    const run = ext === 'step' || ext === 'stp' ? RUN_COMMAND_STEP : RUN_COMMAND;
    // The same view as the image: an up axis chosen for every model, and the palette.
    const flags = `${result.upAxis === 'y' || result.upAxis === 'z' ? ` --up ${result.upAxis}` : ''}${result.palette === 'colorblind' ? ' --palette colorblind' : ''}`;
    groups.push([`git show ${before} > before.${ext}`, `git show ${after} > after.${ext}`, `${run} view before.${ext} after.${ext}${flags}`].join('\n'));
  }
  if (groups.length === 0) return [];
  return [
    '<details><summary>Explore in 3D on your machine</summary>',
    '',
    '```sh',
    `git fetch origin pull/${result.pr}/head`,
    groups.join('\n\n'),
    '```',
    '',
    'Drag to orbit and click any vertex to see where it came from. Needs Node.js 20+.',
    '',
    '</details>',
  ];
}

function footer(result) {
  return `<sub>Rendered by [polymerge](${PROJECT_URL}), structural diff for 3D models · updated for ${short(result.head)}</sub>`;
}

function render(result, { imageUrl, baseRef, maxSections, maxRows }) {
  const files = result.files;
  const lines = [MARKER, '### 3D model diff', ''];
  const against = baseRef ? `${codeSpan(baseRef, { max: 80 })} (merge base ${short(result.base)})` : `the merge base ${short(result.base)}`;
  lines.push(`**${files.length === 1 ? '1 model file' : `${int(files.length)} model files`} changed** against ${against}.`);
  const C = COLORS[result.palette ?? 'standard'] ?? COLOR;
  const withImages = files.filter((f) => f.image && imageUrl(f.image));
  if (withImages.length > 0) {
    lines.push(`<sub>Before on the left, after on the right, seen from the same camera. ${C.moved} moved · ${C.added} added · ${C.removed} removed · grey unchanged</sub>`);
  }
  lines.push('');
  const single = files.length === 1 && files[0].image;
  if (!single) {
    lines.push('| File | Change |', '| --- | --- |');
    for (const f of files.slice(0, maxRows)) lines.push(`| ${fileCell(f)} | ${statusCell(f, result.limits, C)} |`);
    if (files.length > maxRows) lines.push(`| … | ${plural(files.length - maxRows, 'more file')} |`);
    lines.push('');
  }
  const n = notes(files, result.limits);
  if (n.length > 0) lines.push(...n, '');
  const detailed = files.filter((f) => f.status === 'rendered' || (f.status === 'render-failed' && f.diff));
  for (const f of detailed.slice(0, maxSections)) lines.push(...section(f, imageUrl), '');
  if (detailed.length > maxSections) lines.push(`<sub>${plural(detailed.length - maxSections, 'more model')} not shown in detail: the comment would be too long.</sub>`, '');
  const explore = exploreBlock(result, files.filter((f) => f.status === 'rendered' || f.status === 'render-failed' || f.status === 'same-geometry'));
  if (explore.length > 0) lines.push(...explore, '');
  lines.push(footer(result));
  return lines.join('\n');
}

/**
 * The comment body for a validated result. `imageUrl(name)` gives the hosted URL of an image, or
 * null to leave it out (the job-summary preview). `baseRef` is the base branch name, from the API.
 * @param {import('./validate.mjs').RenderResult} result
 * @param {{ imageUrl?: (name: string) => string | null, baseRef?: string | null }} [options]
 * @returns {string}
 */
export function buildComment(result, { imageUrl = () => null, baseRef = null } = {}) {
  for (const [maxSections, maxRows] of [
    [Infinity, Infinity],
    [20, 200],
    [10, 100],
    [3, 40],
    [0, 20],
  ]) {
    const body = render(result, { imageUrl, baseRef, maxSections, maxRows });
    if (body.length <= MAX_BODY) return body;
  }
  return [MARKER, '### 3D model diff', '', `**${plural(result.files.length, 'model file')} changed**; too many to list here.`, '', footer(result)].join('\n');
}

/** The comment once a later push leaves no model changes in the pull request. */
export function buildNoChangesComment(head) {
  return [
    MARKER,
    '### 3D model diff',
    '',
    `This pull request no longer changes any STL, OBJ, glTF or GLB files (as of ${short(head)}).`,
    '',
    `<sub>Rendered by [polymerge](${PROJECT_URL}), structural diff for 3D models · updated for ${short(head)}</sub>`,
  ].join('\n');
}
