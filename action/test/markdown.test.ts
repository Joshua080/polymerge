import { TIER_NAMES } from 'polymerge-core';
import { describe, expect, it } from 'vitest';
import { MARKER, MAX_BODY, TIER_LABELS, buildComment, buildNoChangesComment, codeSpan, shellQuote, visible } from '../lib/markdown.mjs';
import { validateResult } from '../lib/validate.mjs';

const BASE = '1a2b3c4d5e6f'.padEnd(40, '0');
const HEAD = '9f8e7d6c5b4a'.padEnd(40, '1');
const RLO = String.fromCodePoint(0x202e);
const HOSTILE = `models/<img src=x onerror=alert(1)> *b* | [l](javascript:alert(1)) @octocat \`$(id)\` '"${RLO}\nx.stl`;

const diff = {
  tier: 1,
  vertices: { before: 16, after: 16, unchanged: 8, moved: 8, added: 0, removed: 0 },
  faces: { before: 24, after: 24, unchanged: 12, modified: 12, added: 0, removed: 0 },
  maxDisplacement: 6.4,
  parts: [{ name: 'knob', rotationDeg: 30, distance: 6.02 }],
  partsTotal: 1,
  transform: null,
};
const file = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  oldPath: null,
  change: 'modified',
  status: 'rendered',
  image: null,
  error: null,
  modeChanged: false,
  mesh: { before: { vertices: 16, faces: 24 }, after: { vertices: 16, faces: 24 } },
  limit: null,
  diff,
  ...extra,
});
const result = (files: ReturnType<typeof file>[]) =>
  validateResult({ schema: 1, tool: 'polymerge test', pr: 7, base: BASE, head: HEAD, limits: { maxFiles: 10, maxFaces: 200000, maxBytes: 50 * 1024 * 1024 }, files });
const url = (name: string) => `https://github.com/o/r/raw/${'c'.repeat(40)}/pr-7/${name}`;

/** The body with our own <img> tags and every code span / code block removed: what renders as markdown. */
function outsideCode(body: string) {
  return body.replace(/<img src="[^"<>]*" width="800" alt="[^"<>]*">/g, '').replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, '');
}

describe('visible / codeSpan / shellQuote', () => {
  it('shows control, invisible and bidi characters as escapes', () => {
    expect(visible(`a\nb\tc${RLO}d\u0000e`)).toBe('a\\nb\\tc\\u{202e}d\\u{0}e');
    expect(visible(`x${String.fromCodePoint(0x200b)}y${String.fromCodePoint(0xfeff)}`)).toBe('x\\u{200b}y\\u{feff}');
  });

  it('keeps the end of long text (a path keeps its file name)', () => {
    const v = visible(`${'dir/'.repeat(100)}part.stl`, 40);
    expect([...v]).toHaveLength(40);
    expect(v.startsWith('…') && v.endsWith('/part.stl')).toBe(true);
  });

  it('fences code spans longer than any backtick run inside, and pads edge backticks', () => {
    expect(codeSpan('plain.stl')).toBe('`plain.stl`');
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('a``b`')).toBe('``` a``b` ```');
    expect(codeSpan('`x')).toBe('`` `x ``');
  });

  it('escapes pipes inside table cells only', () => {
    expect(codeSpan('a|b', { table: true })).toBe('`a\\|b`');
    expect(codeSpan('a|b')).toBe('`a|b`');
  });

  it('quotes shell arguments, and refuses characters a copied command must not carry', () => {
    expect(shellQuote('abc123:models/part.stl')).toBe('abc123:models/part.stl');
    expect(shellQuote("abc:my part's.stl")).toBe(`'abc:my part'\\''s.stl'`);
    expect(shellQuote('abc:$(rm -rf ~).stl')).toBe("'abc:$(rm -rf ~).stl'");
    expect(shellQuote('abc:a\nb.stl')).toBeNull();
    expect(shellQuote(`abc:${RLO}lts.stl`)).toBeNull();
    expect(shellQuote('')).toBeNull();
  });
});

describe('buildComment', () => {
  it('starts with the marker, and a single rendered model needs no table', () => {
    const body = buildComment(result([file('models/a.obj', { image: '0.png' })]), { imageUrl: url, baseRef: 'main' });
    expect(body.split('\n')[0]).toBe(MARKER);
    expect(body).toContain('**1 model file changed** against `main` (merge base `1a2b3c4`).');
    expect(body).not.toContain('| File | Change |');
    expect(body).toContain(`<img src="${url('0.png')}" width="800" alt="Before and after: models/a.obj">`);
    expect(body).toContain('- **Moved part** `knob` moved 6.02, turned 30°');
    expect(body).toContain('- **Vertices** 8 moved · 0 added · 0 removed (16 → 16)');
    expect(body).toContain('<sub>Matched by Tier 1 · index/ID (direct lineage). Largest vertex move 6.4.</sub>');
    expect(body).toContain('updated for `9f8e7d6`');
    expect(body).toContain('[polymerge](https://github.com/Joshua080/polymerge)');
  });

  it('gives a copy-paste command to explore a changed model locally, quoted', () => {
    const body = buildComment(result([file("models/my part's.obj", { image: '0.png' })]), { imageUrl: url });
    expect(body).toContain(
      ['git fetch origin pull/7/head', `git show '1a2b3c4d5e6f:models/my part'\\''s.obj' > before.obj`, `git show '9f8e7d6c5b4a:models/my part'\\''s.obj' > after.obj`, 'npx @joshuahurley/polymerge view before.obj after.obj'].join('\n'),
    );
  });

  it('uses the colour-blind squares, and opens the local view the same way, when the images did', () => {
    const r = { ...result([file('models/a.obj', { image: '0.png' }), file('models/b.stl', { change: 'added', image: '1.png', diff: null, mesh: { before: null, after: { vertices: 8, faces: 12 } } })]), palette: 'colorblind' as const, upAxis: 'z' as const };
    const body = buildComment(r, { imageUrl: url });
    expect(body).toContain('🟨 moved · 🟦 added · 🟧 removed · grey unchanged');
    expect(body).toContain('| 🟦 added · 12 faces |');
    expect(body).not.toContain('🟩');
    expect(body).toContain('npx @joshuahurley/polymerge view before.obj after.obj --up z --palette colorblind');
    const standard = buildComment(result([file('models/a.obj', { image: '0.png' })]), { imageUrl: url });
    expect(standard).toContain('🟨 moved · 🟩 added · 🟥 removed');
    expect(standard).toContain('polymerge view before.obj after.obj\n');
  });

  it('the command for a STEP file brings the optional OpenCascade reader along', () => {
    const body = buildComment(result([file('cad/bracket.STP', { image: '0.png' })]), { imageUrl: url });
    expect(body).toContain('npx -p @joshuahurley/polymerge -p occt-import-js@0.0.23 polymerge view before.stp after.stp');
  });

  it('keeps a hostile file name inert: code spans only, rows intact, no command for it', () => {
    const body = buildComment(
      result([file(HOSTILE, { image: '0.png' }), file('models/other.stl', { status: 'error', image: null, diff: null, error: `<b>boom</b> ${HOSTILE}` }), file(`${HOSTILE}.2.stl`, { status: 'same-content', image: null, diff: null, change: 'renamed', oldPath: HOSTILE })]),
      { imageUrl: url },
    );
    expect(body).toContain('onerror'); // it is there, as literal text …
    expect(outsideCode(body)).not.toMatch(/onerror|<img|<b>|\]\(javascript|@octocat|\*b\*|\$\(id\)/); // … but only inside code
    expect(body).not.toContain(RLO);
    expect(body.split('\n').some((l) => l.startsWith('x.stl'))).toBe(false);
    const rows = body.split('\n').filter((l) => l.startsWith('| '));
    expect(rows.length).toBe(5);
    for (const row of rows) expect(row.replace(/\\\|/g, '').split('|')).toHaveLength(4);
    expect(body).not.toContain('<details>'); // its name can't go into a shell command
    const alt = /alt="([^"]*)"/.exec(body)?.[1] ?? '';
    expect(alt).not.toMatch(/[<>`]/);
  });

  it('explains LFS pointers, unreadable files and the caps', () => {
    const body = buildComment(
      result([
        file('a.glb', { status: 'lfs', diff: null, change: 'added', mesh: { before: null, after: null } }),
        file('b.obj', { status: 'error', diff: null, error: 'b.obj: OBJ contains no triangle faces' }),
        file('c.stl', { status: 'too-large', diff: null, limit: { what: 'faces', value: 300000, max: 200000 } }),
        file('d.stl', { status: 'not-rendered', diff: null }),
        file('e.stl', { status: 'same-content', diff: null, modeChanged: true }),
        file('f.stl', { status: 'same-geometry', diff: { ...diff, vertices: { ...diff.vertices, moved: 0 }, faces: { ...diff.faces, modified: 0 }, parts: [], partsTotal: 0, transform: { units: { from: 'in', to: 'mm', factor: 25.4 }, scale: 25.4, rotationDeg: 0, distance: 0 } } }),
      ]),
    );
    expect(body).toContain('| `a.glb` | ⚠️ Git LFS file, not fetched |');
    expect(body).toMatch(/`a\.glb` is stored in \*\*Git LFS\*\*.*Add `lfs: true` to the `actions\/checkout` step/);
    expect(body).toContain('- ⚠️ `b.obj` could not be read as a model: `b.obj: OBJ contains no triangle faces`');
    expect(body).toContain('| `c.stl` | ⚠️ too large to render (300,000 faces; limit 200,000) |');
    expect(body).toContain('(the `max-triangles` and `max-file-size` inputs)');
    expect(body).toContain('| `d.stl` | not rendered: over the limit of 10 models per comment |');
    expect(body).toContain('| `e.stl` | file mode changed, content unchanged |');
    expect(body).toContain('| `f.stl` | whole model units in → mm (×25.4), no local change |');
    expect(body).not.toContain('<img');
    expect(body).not.toContain('Before on the left'); // no legend without images
  });

  it('stays under GitHub’s comment size limit however many long names there are', () => {
    const many = Array.from({ length: 400 }, (_, i) => file(`${'<*|`'.repeat(200)}${i}.stl`, { image: i < 100 ? `${i}.png` : null, status: i < 100 ? 'rendered' : 'not-rendered' }));
    const body = buildComment(result(many), { imageUrl: url });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('**400 model files changed**');
  });

  it('says so when a later push removes every model change', () => {
    const body = buildNoChangesComment(HEAD);
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(body).toContain('no longer changes any 3D model files (as of `9f8e7d6`)');
  });

  it('uses the engine’s tier names', () => {
    for (const t of [1, 2, 3] as const) expect(TIER_NAMES[t]).toBe(`Tier ${t} · ${TIER_LABELS[t]}`);
  });
});

describe('geometry in the comment', () => {
  const geometry = (extra: Record<string, unknown> = {}) => ({
    unit: 'mm',
    size: { before: [100, 60, 10], after: [100, 60, 12] },
    area: { before: 18_920, after: 19_500 },
    volume: { before: 52_345.6, after: 55_100 },
    closed: { before: true, after: true },
    ...extra,
  });

  it('a line per model with volume, size and surface, and the volume change in the table', () => {
    const body = buildComment(result([file('a.3mf', { image: '0.png', diff: { ...diff, geometry: geometry() } }), file('b.stl', { image: '1.png' })]));
    expect(body).toContain('- **Geometry** volume 52.35 cm³ → 55.1 cm³ (+5.3%) · size 100 × 60 × 10 mm → 100 × 60 × 12 mm · surface +5.8 cm² (+3.1%)');
    expect(body).toMatch(/\| `a\.3mf` \| .* · volume \+2\.754 cm³ \(\+5\.3%\) \|/);
  });

  it('says which version is not closed, and when the unit is unknown', () => {
    const open = geometry({ unit: null, volume: null, closed: { before: true, after: false } });
    const body = buildComment(result([file('a.stl', { image: '0.png', diff: { ...diff, geometry: open } })]));
    expect(body).toContain('no volume (the after version is not a closed surface)');
    expect(body).toContain('(in the file’s own units)');
  });

  it('rejects malformed geometry', () => {
    expect(() => result([file('a.stl', { image: '0.png', diff: { ...diff, geometry: geometry({ unit: 'furlong' }) } })])).toThrow(/geometry\.unit/);
    expect(() => result([file('a.stl', { image: '0.png', diff: { ...diff, geometry: geometry({ size: { before: [1, 2], after: [1, 2, 3] } }) } })])).toThrow(/size\.before/);
    expect(() => result([file('a.stl', { image: '0.png', diff: { ...diff, geometry: geometry({ area: { before: -1, after: 2 } }) } })])).toThrow(/negative/);
  });
});
