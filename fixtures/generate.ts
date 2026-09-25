/**
 * Fixture generator.  `npm run fixtures`  (=  npx tsx fixtures/generate.ts)
 *
 * (Re)writes fixtures/cases/<id>/base.<ext>, fixtures/cases/<id>/target.<ext> and
 * fixtures/manifest.json. Output is deterministic and byte-identical on re-run.
 *
 *   --out <dir>   write into <dir> instead of fixtures/ (used by the self-check)
 *   --quiet       no summary table
 *
 * Stale case directories under <out>/cases are removed first.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures } from './lib/cases.js';

function main(argv: string[]): void {
  const here = dirname(fileURLToPath(import.meta.url));
  let out = here;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] ?? '');
    else if (argv[i] === '--quiet') quiet = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const built = buildFixtures();
  rmSync(join(out, 'cases'), { recursive: true, force: true });
  let total = 0;
  for (const [rel, bytes] of built.files) {
    const path = join(out, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    total += bytes.length;
  }
  if (quiet) return;
  const rows = built.cases.map((c) => {
    const e = c.fixture.expect;
    return [
      c.fixture.id,
      `${c.fixture.base.split('.').pop()} → ${c.fixture.target.split('.').pop()}`,
      e.acceptableTiers.join('|'),
      `${e.baseMesh?.vertexCount}v/${e.baseMesh?.faceCount}f → ${e.targetMesh?.vertexCount}v/${e.targetMesh?.faceCount}f`,
    ];
  });
  const widths = [0, 1, 2, 3].map((k) => Math.max(...rows.map((r) => r[k].length)));
  for (const r of rows) console.log(r.map((cell, k) => cell.padEnd(widths[k])).join('  '));
  console.log(`\n${built.cases.length} cases, ${built.files.size} files, ${total} bytes → ${out}`);
}

main(process.argv.slice(2));
