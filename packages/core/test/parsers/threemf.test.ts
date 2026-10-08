import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { describe, expect, it } from 'vitest';
import { detectFormat, loadMesh, sniffFormat } from '../../src/parsers/index.js';
import { parseThreeMfTransform, scanXml } from '../../src/parsers/threemf.js';
import { MeshLoadError } from '../../src/types.js';
import { writeThreeMf } from '../../src/writers/index.js';
import { CUBE_CORNERS, CUBE_EXPECTED_FACES, CUBE_EXPECTED_POSITIONS, CUBE_TRIS, utf8 } from './helpers.js';

const RELS = (target = '/3D/3dmodel.model') =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Target="${target}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

/** A 3MF package from model XML parts (independent of the writer under test). */
function pkg(parts: Record<string, string>, rels = RELS()): Uint8Array {
  const files: Record<string, Uint8Array> = { '_rels/.rels': utf8(rels), '[Content_Types].xml': utf8('<Types/>'), 'Metadata/thumbnail.png': new Uint8Array(64) };
  for (const [name, xml] of Object.entries(parts)) files[name] = utf8(xml);
  return zipSync(files);
}

function meshXml(corners: number[][], tris: number[][], triAttrs: (t: number) => string = () => ''): string {
  return (
    '<mesh><vertices>' +
    corners.map((c) => `<vertex x="${c[0]}" y="${c[1]}" z="${c[2]}"/>`).join('\n') +
    '</vertices><triangles>' +
    tris.map((t, i) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${triAttrs(i)}/>`).join('\n') +
    '</triangles></mesh>'
  );
}

const model = (body: string, attrs = 'unit="millimeter"') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported by a test -->\n<model ${attrs} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">${body}</model>`;

describe('3MF', () => {
  it('one mesh object → the same arrays as the STL / OBJ / PLY cube, named after the object', async () => {
    const bytes = pkg({ '3D/3dmodel.model': model(`<resources><object id="1" type="model" name="Cube &amp; lid">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object></resources><build><item objectid="1"/></build>`) });
    const mesh = await loadMesh(bytes, { fileName: 'cube.3mf' });
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.groups).toEqual([{ name: 'Cube & lid', faceStart: 0, faceCount: 12 }]);
    expect(mesh.metadata).toMatchObject({ format: '3mf', extras: { threemf: { unit: 'millimeter', convertedTo: 'mm', buildItems: 1, instances: 1 } } });
  });

  it('converts units to millimetres and applies build-item and component transforms (row-vector 3MF matrices)', async () => {
    // Inches: the cube becomes 25.4 mm; the item moves it 1 inch in x and rotates 90° about z.
    const xml = model(
      `<resources><object id="1" type="model">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object>` +
        `<object id="2" type="model" name="assembly"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 2"/></components></object></resources>` +
        `<build><item objectid="2" transform="0 1 0 -1 0 0 0 0 1 1 0 0"/></build>`,
      'unit="inch"',
    );
    const mesh = await loadMesh(pkg({ '3D/3dmodel.model': xml }), { fileName: 'a.3mf' });
    const b = mesh.metadata.bounds;
    // Rotation (x, y) → (−y, x), then +1 inch in x; the component lifts it 2 inches in z.
    expect(b.min.map((v) => Number(v.toFixed(4)))).toEqual([0, 0, 50.8]);
    expect(b.max.map((v) => Number(v.toFixed(4)))).toEqual([25.4, 25.4, 76.2]);
    expect(mesh.groups[0].name).toBe('assembly'); // unnamed mesh object → its parent's name
    expect(mesh.metadata.extras).toMatchObject({ threemf: { unit: 'inch' } });
  });

  it('reads Production-extension parts (Bambu / Orca layout) and keeps instances as separate groups', async () => {
    const root = model(
      `<resources><object id="5" type="model" name="Bracket"><components>` +
        `<component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources>` +
        `<build><item objectid="5"/><item objectid="5" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build>`,
      'unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"',
    );
    const object = model(`<resources><object id="1" type="model">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object></resources><build/>`);
    const mesh = await loadMesh(pkg({ '3D/3dmodel.model': root, '3D/Objects/object_1.model': object }), { fileName: 'bambu.3mf' });
    expect(mesh.groups.map((g) => g.name)).toEqual(['Bracket', 'Bracket #2']);
    expect(mesh.faceCount).toBe(24);
    expect(mesh.metadata.bounds.max[0]).toBe(11);
    expect(mesh.metadata.warnings).toEqual([]);
    expect(mesh.metadata.extras).toMatchObject({ threemf: { modelParts: ['3D/3dmodel.model', '3D/Objects/object_1.model'], instances: 2 } });
  });

  it('base materials and colour groups → materials and per-face materials', async () => {
    const xml = model(
      `<resources><basematerials id="1"><base name="PLA Red" displaycolor="#FF0000"/><base name="PLA White" displaycolor="#FFFFFFFF"/></basematerials>` +
        `<m:colorgroup id="2"><m:color color="#0000FF80"/></m:colorgroup>` +
        `<object id="3" type="model" pid="1" pindex="1">${meshXml(CUBE_CORNERS, CUBE_TRIS, (t) => (t < 2 ? ' pid="1" p1="0"' : t < 4 ? ' pid="2" p1="0" p2="0" p3="0"' : ''))}</object></resources>` +
        `<build><item objectid="3"/></build>`,
      'unit="millimeter" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"',
    );
    const mesh = await loadMesh(pkg({ '3D/3dmodel.model': xml }), { fileName: 'c.3mf' });
    expect(mesh.materials.map((m) => m.name)).toEqual(['PLA Red', '#0000ff80', 'PLA White']);
    expect(mesh.materials[0].color).toEqual([1, 0, 0, 1]);
    expect(mesh.materials[1].color?.[3]).toBeCloseTo(128 / 255);
    expect(Array.from(mesh.faceMaterials!)).toEqual([0, 0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('follows the package relationships to a root part with another name', async () => {
    const bytes = pkg({ 'models/main.model': model(`<resources><object id="1">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object></resources><build><item objectid="1"/></build>`) }, RELS('/models/main.model'));
    expect((await loadMesh(bytes, { fileName: 'x.3mf' })).faceCount).toBe(12);
  });

  it('warns about required extensions it does not read, and about missing objects', async () => {
    const xml = model(
      `<resources><object id="1">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object></resources><build><item objectid="1"/><item objectid="9"/></build>`,
      'unit="millimeter" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" requiredextensions="b"',
    );
    const mesh = await loadMesh(pkg({ '3D/3dmodel.model': xml }), { fileName: 'w.3mf' });
    expect(mesh.metadata.warnings.join('\n')).toMatch(/beamlattice.*may be incomplete/);
    expect(mesh.metadata.warnings.join('\n')).toMatch(/does not contain: 3D\/3dmodel\.model#9/);
  });

  it('refuses what it cannot show, with clear messages', async () => {
    await expect(loadMesh(utf8('not a zip at all'), { fileName: 'a.3mf' })).rejects.toThrow(/not a 3MF file/);
    await expect(loadMesh(zipSync({ 'readme.txt': utf8('hi') }), { fileName: 'b.3mf' })).rejects.toThrow(/no 3D model part/);
    const empty = pkg({ '3D/3dmodel.model': model('<resources/><build/>') });
    const err = await loadMesh(empty, { fileName: 'c.3mf' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshLoadError);
    expect((err as Error).message).toMatch(/c\.3mf: the 3MF has no triangles to show \(its build section is empty\)/);
    const secure = pkg({ '3D/3dmodel.model': model('<resources/><build/>', 'xmlns:s="http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04" requiredextensions="s"') });
    await expect(loadMesh(secure, { fileName: 'd.3mf' })).rejects.toThrow(/encrypted/);
  });

  it('is detected by extension and by content (a ZIP holding a .model part)', () => {
    const bytes = pkg({ '3D/3dmodel.model': model('<resources/><build/>') });
    expect(detectFormat(bytes, 'Part.3MF')).toBe('3mf');
    expect(sniffFormat(bytes)).toBe('3mf');
    expect(sniffFormat(zipSync({ 'a.txt': utf8('x') }))).toBeUndefined();
  });

  it('round-trips through the 3MF writer: groups, positions, colours; same bytes every time', async () => {
    const xml = model(
      `<resources><basematerials id="1"><base name="Red" displaycolor="#FF0000"/><base name="Blue" displaycolor="#0000FF"/></basematerials>` +
        `<object id="2" name="left" pid="1" pindex="0">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object>` +
        `<object id="3" name="right" pid="1" pindex="1">${meshXml(CUBE_CORNERS, CUBE_TRIS)}</object></resources>` +
        `<build><item objectid="2"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 3 0 0"/></build>`,
    );
    const source = await loadMesh(pkg({ '3D/3dmodel.model': xml }), { fileName: 's.3mf' });
    const written = writeThreeMf(source, { name: 's.3mf' });
    expect(writeThreeMf(source, { name: 's.3mf' })).toEqual(written);
    const back = await loadMesh(written, { fileName: 'back.3mf' });
    expect(back.groups).toEqual(source.groups);
    expect(Array.from(back.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(back.faces)).toEqual(Array.from(source.faces));
    expect(back.materials.map((m) => m.name)).toEqual(['Red', 'Blue']);
    expect(Array.from(back.faceMaterials!)).toEqual(Array.from(source.faceMaterials!));
  });
});

describe('3MF helpers', () => {
  it('scanXml: attributes by local name, entities, comments, CDATA, processing instructions', () => {
    const seen: string[] = [];
    scanXml(
      `<?xml version="1.0"?><!-- <fake a="1"/> --><a:root xmlns:a="urn:x" a:k='v &lt;1&gt;'><![CDATA[<nope/>]]><child x="1"/></a:root>`,
      (name, attrs, selfClosing) => seen.push(`open ${name} ${JSON.stringify(attrs)} ${selfClosing}`),
      (name) => seen.push(`close ${name}`),
    );
    expect(seen).toEqual(['open root {"xmlns:a":"urn:x","k":"v <1>"} false', 'open child {"x":"1"} true', 'close root']);
  });

  it('parseThreeMfTransform: row-vector layout → column-major, translation scaled to mm', () => {
    expect(parseThreeMfTransform('1 0 0 0 1 0 0 0 1 4 5 6', 10)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 50, 60, 1]);
    expect(parseThreeMfTransform('1 2 3', 1)).toBeNull();
    expect(parseThreeMfTransform(undefined, 1)).toBeNull();
  });
});
