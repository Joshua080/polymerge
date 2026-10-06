#!/usr/bin/env node
/**
 * Generates the STEP example and test files with a real B-rep kernel (OpenCascade, through
 * replicad), so they are what a CAD tool exports: exact surfaces, fillets, holes cut by
 * boolean operations, names and colours.
 *
 *   examples/step-plate/{base,ours,theirs}.step   a 100 × 60 × 10 mm plate, fillets r5, two Ø8 holes;
 *                                                 ours moves one hole +5 mm in X, theirs adds a Ø6 hole
 *   packages/cli/test/fixtures/step/assembly-mm.step     three named, coloured solids: a plate and two
 *                                                        identical pins (a part used twice)
 *   packages/cli/test/fixtures/step/assembly-inch.step   the same assembly written in inches
 *
 * The files are committed; this script only documents and repeats how they were made. replicad
 * is not a dependency of polymerge (its OpenCascade build is ~50 MB), so install it first, without
 * touching package.json:
 *
 *   npm install --no-save replicad@1.1.0 replicad-opencascadejs@1.1.0
 *   node scripts/make-step-examples.mjs
 *
 * (or point REPLICAD_FROM at any directory whose node_modules has both). The STEP header's
 * time stamp is fixed, so re-running gives the same bytes.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(path.resolve(process.env.REPLICAD_FROM ?? root), 'noop.js'));

let replicad, opencascade;
try {
  replicad = await import(pathToFileURL(require.resolve('replicad')).href);
  opencascade = (await import(pathToFileURL(require.resolve('replicad-opencascadejs')).href)).default;
} catch {
  console.error('make-step-examples: replicad is not installed. Run:\n  npm install --no-save replicad@1.1.0 replicad-opencascadejs@1.1.0');
  process.exit(1);
}
const { setOC, makeBaseBox, makeCylinder, exportSTEP } = replicad;
setOC(await opencascade({ locateFile: () => require.resolve('replicad-opencascadejs/wasm') }));

function plate({ holes, corner = 5 }) {
  let s = makeBaseBox(100, 60, 10).fillet(corner, (e) => e.inDirection('Z'));
  for (const [x, y, r] of holes) s = s.cut(makeCylinder(r, 20, [x, y, -5], [0, 0, 1]));
  return s;
}

/** A pin: a Ø6 shaft 20 mm long with a Ø10 head, standing at (x, y) on top of the plate. */
function pin(x, y) {
  const shaft = makeCylinder(3, 20, [x, y, 10], [0, 0, 1]);
  const head = makeCylinder(5, 3, [x, y, 30], [0, 0, 1]);
  return shaft.fuse(head);
}

/**
 * replicad hands a hex colour to OpenCascade as LINEAR RGB, and OpenCascade writes STEP colours
 * sRGB-encoded; so pass the linear form of the sRGB colour the file should contain.
 */
function fileColor(hex) {
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const channels = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
  return `#${channels.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

async function write(file, shapes, options) {
  const blob = exportSTEP(shapes, options);
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  // FILE_NAME('name','2026-09-29T10:45:54',...): a fixed time stamp keeps the bytes reproducible.
  const fixed = text.replace(/(FILE_NAME\('[^']*',')\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d'/, "$12026-10-05T00:00:00'");
  const out = path.join(root, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, fixed, 'latin1');
  console.log(`${file}  ${fs.statSync(out).size} bytes`);
}

const steel = fileColor('#7d93ad');
const brass = fileColor('#e0a030');
await write('examples/step-plate/base.step', [{ shape: plate({ holes: [[-30, 0, 4], [30, 0, 4]] }), name: 'plate', color: steel }]);
await write('examples/step-plate/ours.step', [{ shape: plate({ holes: [[-30, 0, 4], [35, 0, 4]] }), name: 'plate', color: steel }]);
await write('examples/step-plate/theirs.step', [{ shape: plate({ holes: [[-30, 0, 4], [30, 0, 4], [0, 15, 3]] }), name: 'plate', color: steel }]);

const assembly = () => [
  { shape: plate({ holes: [[-30, 0, 4], [30, 0, 4]] }), name: 'plate', color: steel },
  { shape: pin(-30, 20), name: 'pin', color: brass },
  { shape: pin(30, 20), name: 'pin', color: brass },
];
await write('packages/cli/test/fixtures/step/assembly-mm.step', assembly());
await write('packages/cli/test/fixtures/step/assembly-inch.step', assembly(), { unit: 'INCH', modelUnit: 'MM' });
