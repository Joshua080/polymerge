#!/usr/bin/env node
/**
 * polymerge CLI — structural diff and three-way merge for 3D models, all of it usable from a
 * terminal (plain-text reports, --json for machines, --ascii for old consoles).
 *
 *   polymerge diff <base> <target> [--json <file|->] [--force-tier 1|2|3] ...
 *   polymerge view <base> <target> [--port N] [--no-open]
 *   polymerge view <base> <ours> <theirs> [--port N] [--no-open]
 *   polymerge review <path>              (merge review of a conflicted git merge)
 *   polymerge export <base> <target> [-o page.html]   (the diff and the viewer in one HTML file)
 *   polymerge demo [example]             (the viewer on a built-in example)
 *   polymerge info <file> [--json]
 *   polymerge section <file> [<file2>] [--x|--y|--z <value>] [--svg out.svg] [--json]
 *   polymerge measure <file> <point> <point> [--no-snap] [--json]
 *   polymerge merge <base> <ours> <theirs> [-o merged.stl|obj|glb|gltf|ply|3mf] [--resolve ours|theirs|base] [--pick id=side]
 *   polymerge git-diff <git external-diff args...>
 *   polymerge git-merge %O %A %B %P
 *   polymerge git-setup
 *   polymerge init [--global] [--dry-run]
 */
import { parseArgs } from 'node:util';
import { installAsciiOutput, wantsAscii } from './ascii.js';
import { runDiff } from './commands/diff.js';
import { runExport } from './commands/export.js';
import { gitSetupText, runGitDiff } from './commands/git.js';
import { runInfo } from './commands/info.js';
import { runInit } from './commands/init.js';
import { runMeasure } from './commands/measure.js';
import { runSection } from './commands/section.js';
import { runGitMerge, runGitResolve, runMerge } from './commands/merge.js';
import { createRequire } from 'node:module';
import { MERGE_DEMOS, runDemo, runReview, runView } from './commands/view.js';

const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const HELP = `polymerge ${VERSION} — structural diff and three-way merge for 3D models
STL, OBJ, glTF/GLB, 3MF, PLY and STEP. Everything works in a terminal; "view" opens a browser.

Compare two versions
  polymerge diff <old> <new> [options]       What changed: correspondence, counts, where it changed,
                                             size / volume / area, and for STEP each CAD face
      --top <n>              How many individual vertex moves to list (default 10)
      --regions <n>          How many regions of change to list (default 5)
      --json <file|->        Also write the full result as JSON ("-" = stdout)
      --exit-code            Exit 1 when the models differ (like git diff --exit-code)
      --force-tier <1|2|3>   Run only this correspondence tier
      --move-eps <n>         Displacement above which a vertex counts as moved
      --surface-tol <n>      Tier 3 surface distance above which geometry is added/removed
      -q, --quiet            No report or engine log (useful with --json)
      -v, --verbose          Include engine debug logging

Inspect one model
  polymerge info <file> [--json]             Format, counts, size, surface area, volume, parts,
                                             materials; STEP: its CAD faces
  polymerge section <file> [<file2>] [--x <v> | --y <v> | --z <v>] [--svg <out.svg>] [--json]
                                             Cut with a plane (default: z at the middle; "25%"
                                             works too): outlines, holes, perimeters, areas;
                                             with two files, how the cut changed
  polymerge measure <file> <point> <point> [--no-snap] [--json]
                                             Distance between two points, each snapped to the
                                             nearest point of the surface; a point is x,y,z or
                                             v:<vertex number>

Merge three versions
  polymerge merge <base> <ours> <theirs> [options]   Three-way merge (exit 1 = unresolved conflicts)
      -o, --output <file>    Write the result: .stl .obj .glb .gltf .ply .3mf
      --resolve <side>       Resolve every conflict with ours | theirs | base
      --pick <id>=<side>     Resolve one conflict (repeatable), e.g. --pick 0=theirs
      --report <file>        Write the conflicts and statistics as JSON
      --no-collision-check   Don't check the combined edits for surfaces passing through each other
      -q, --quiet            No report
                             glTF/GLB inputs also merge materials, UVs and texture references
  polymerge resolve <path> [--pick <id>=<side> | --resolve <side>] [--dry-run]
                                             Finish a conflicted git merge of <path> from git's
                                             index stages; --dry-run lists the conflicts only

See it in the browser
  polymerge view <old> <new> [options]       The interactive 3D diff
  polymerge view <base> <ours> <theirs>      The merge review: see conflicts, resolve by clicking
  polymerge review <path>                    The merge review of a conflicted git merge of <path>;
                                             "Save to repository" writes <path> and stages it
  polymerge export <old> <new> [-o <page.html>] [--up y|z]
                                             The diff and the viewer in ONE HTML file: it opens in
                                             any browser, offline, nothing to install (email it,
                                             attach it to a ticket). Default name: <old>__<new>.html
  polymerge demo [example]                   The viewer on a built-in example, no files needed
                                             Merge review: ${MERGE_DEMOS.join(', ')} (default ${MERGE_DEMOS[0]})
                                             Diff: e.g. moved-part, grid-bump, units-inch-to-mm
      --port <n>             Port (default 5178, falls back to a free port)
      --host <addr>          Bind address (default 127.0.0.1)
      --name <file>          Display name for every side (git difftool passes $MERGED)
      --no-open              Do not launch a browser, just print the URL
      --up <y|z>             Which axis points up (default: Z for STEP, else Y)
      --palette <name>       standard, or colorblind (blue / orange / yellow)
      --web-dist <dir>       Path to a built viewer (default: the one bundled with polymerge)

Git
  polymerge init [--global] [--dry-run]      Set git up for polymerge: .gitattributes and drivers
  polymerge git-setup                        Print the git configuration instead
  polymerge git-diff <7 git args>            git external diff driver (diff.<name>.command)
  polymerge git-merge %O %A %B %P            git merge driver (merge.<name>.driver)

Everywhere
  --ascii / --unicode        Plain ASCII output (automatic in the classic Windows console), or not
  polymerge --version | --help

STEP (.step, .stp) works with diff, view, export, info, section, measure and git-diff, not merge. It
needs OpenCascade, an optional download: npm install -g occt-import-js@0.0.23 (LGPL-2.1, ~8 MB).
`;

async function main(args: string[]): Promise<number> {
  // Output flags valid before or after any command.
  const flags = { ascii: args.includes('--ascii'), unicode: args.includes('--unicode') };
  const argv = args.filter((a) => a !== '--ascii' && a !== '--unicode');
  if (wantsAscii(flags)) installAsciiOutput();
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return command === undefined ? 1 : 0;
    case '-V':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'diff': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          json: { type: 'string' },
          'force-tier': { type: 'string' },
          'move-eps': { type: 'string' },
          'surface-tol': { type: 'string' },
          top: { type: 'string' },
          regions: { type: 'string' },
          'exit-code': { type: 'boolean' },
          quiet: { type: 'boolean', short: 'q' },
          verbose: { type: 'boolean', short: 'v' },
        },
      });
      requirePositionals('diff', positionals, 2);
      return runDiff(positionals[0], positionals[1], {
        json: values.json,
        forceTier: values['force-tier'],
        moveEpsilon: values['move-eps'],
        surfaceTolerance: values['surface-tol'],
        top: values.top,
        regions: values.regions,
        exitCode: values['exit-code'],
        quiet: values.quiet,
        verbose: values.verbose,
      });
    }
    case 'view': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          port: { type: 'string' },
          host: { type: 'string' },
          name: { type: 'string' },
          'no-open': { type: 'boolean' },
          'web-dist': { type: 'string' },
          up: { type: 'string' },
          palette: { type: 'string' },
        },
      });
      if (positionals.length !== 2 && positionals.length !== 3) {
        throw new UsageError(`polymerge view: expected 2 files (diff) or 3 (merge: base ours theirs), got ${positionals.length}`);
      }
      return runView(positionals, {
        port: values.port,
        host: values.host,
        open: !values['no-open'],
        webDist: values['web-dist'],
        name: values.name,
        up: values.up,
        palette: values.palette,
      });
    }
    case 'demo': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          port: { type: 'string' },
          host: { type: 'string' },
          'no-open': { type: 'boolean' },
          'web-dist': { type: 'string' },
          up: { type: 'string' },
          palette: { type: 'string' },
        },
      });
      if (positionals.length > 1) throw new UsageError(`polymerge demo: expected at most 1 example name, got ${positionals.length}`);
      return runDemo(positionals[0], { port: values.port, host: values.host, open: !values['no-open'], webDist: values['web-dist'], up: values.up, palette: values.palette });
    }
    case 'export': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          output: { type: 'string', short: 'o' },
          up: { type: 'string' },
          'web-dist': { type: 'string' },
          'force-tier': { type: 'string' },
          'move-eps': { type: 'string' },
          'surface-tol': { type: 'string' },
          quiet: { type: 'boolean', short: 'q' },
          verbose: { type: 'boolean', short: 'v' },
        },
      });
      requirePositionals('export', positionals, 2);
      return runExport(positionals[0], positionals[1], {
        output: values.output,
        up: values.up,
        webDist: values['web-dist'],
        forceTier: values['force-tier'],
        moveEpsilon: values['move-eps'],
        surfaceTolerance: values['surface-tol'],
        quiet: values.quiet,
        verbose: values.verbose,
        version: VERSION,
      });
    }
    case 'info': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
      requirePositionals('info', positionals, 1);
      return runInfo(positionals[0], { json: values.json });
    }
    case 'section': {
      const { values, positionals } = parseArgs({
        args: hideNegatives(rest),
        allowPositionals: true,
        options: { x: { type: 'string' }, y: { type: 'string' }, z: { type: 'string' }, svg: { type: 'string' }, json: { type: 'boolean' } },
      });
      if (positionals.length !== 1 && positionals.length !== 2) throw new UsageError(`polymerge section: expected 1 file (or 2 to compare), got ${positionals.length}`);
      return runSection(positionals.map((f) => unhide(f)), { ...values, x: unhide(values.x), y: unhide(values.y), z: unhide(values.z) });
    }
    case 'measure': {
      const { values, positionals } = parseArgs({
        args: hideNegatives(rest),
        allowPositionals: true,
        options: { 'no-snap': { type: 'boolean' }, json: { type: 'boolean' } },
      });
      if (positionals.length !== 3) throw new UsageError(`polymerge measure: expected a file and two points (x,y,z or v:<vertex>), got ${positionals.length} argument(s)`);
      const [file, a, b] = positionals.map((x) => unhide(x));
      return runMeasure(file, a, b, { snap: !values['no-snap'], json: values.json });
    }
    case 'merge': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          output: { type: 'string', short: 'o' },
          format: { type: 'string' },
          resolve: { type: 'string' },
          pick: { type: 'string', multiple: true },
          report: { type: 'string' },
          quiet: { type: 'boolean', short: 'q' },
          'no-collision-check': { type: 'boolean' },
        },
      });
      requirePositionals('merge', positionals, 3);
      return runMerge(positionals[0], positionals[1], positionals[2], {
        output: values.output,
        format: values.format,
        resolve: values.resolve,
        pick: values.pick,
        report: values.report,
        quiet: values.quiet,
        collisionCheck: !values['no-collision-check'],
      });
    }
    case 'review': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          port: { type: 'string' },
          host: { type: 'string' },
          'no-open': { type: 'boolean' },
          'web-dist': { type: 'string' },
          up: { type: 'string' },
          palette: { type: 'string' },
        },
      });
      requirePositionals('review', positionals, 1);
      return runReview(positionals[0], { port: values.port, host: values.host, open: !values['no-open'], webDist: values['web-dist'], up: values.up, palette: values.palette });
    }
    case 'resolve': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          resolve: { type: 'string' },
          pick: { type: 'string', multiple: true },
          format: { type: 'string' },
          quiet: { type: 'boolean', short: 'q' },
          'no-collision-check': { type: 'boolean' },
          'dry-run': { type: 'boolean' },
        },
      });
      requirePositionals('resolve', positionals, 1);
      return runGitResolve(positionals[0], {
        resolve: values.resolve,
        pick: values.pick,
        format: values.format,
        quiet: values.quiet,
        collisionCheck: !values['no-collision-check'],
        dryRun: values['dry-run'],
      });
    }
    case 'git-diff':
      return runGitDiff(rest);
    case 'git-merge': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { resolve: { type: 'string' }, 'no-collision-check': { type: 'boolean' } },
      });
      return runGitMerge(positionals, { resolve: values.resolve, collisionCheck: !values['no-collision-check'] });
    }
    case 'git-setup':
      process.stdout.write(gitSetupText() + '\n');
      return 0;
    case 'init': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { global: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
      });
      if (positionals.length > 0) throw new UsageError(`polymerge init: takes no file arguments (got ${positionals.join(' ')})`);
      return runInit({ global: values.global, dryRun: values['dry-run'] });
    }
    default:
      process.stderr.write(`polymerge: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

/**
 * Negative numbers ("-5", "-5,0,2", "-12.5%") are values, not options: hide their dash from
 * parseArgs (which would reject them as unknown options), then `unhide` what it returns.
 */
const NEGATIVE = '\u0000';
const hideNegatives = (args: string[]): string[] => args.map((a) => (/^-\.?\d/.test(a) ? NEGATIVE + a : a));
function unhide(s: string): string;
function unhide(s: string | undefined): string | undefined;
function unhide(s: string | undefined): string | undefined {
  return s?.startsWith(NEGATIVE) ? s.slice(1) : s;
}

function requirePositionals(cmd: string, positionals: string[], n: number): void {
  if (positionals.length !== n) {
    throw new UsageError(`polymerge ${cmd}: expected ${n} file argument${n === 1 ? '' : 's'}, got ${positionals.length}`);
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const e = err as Error & { code?: string };
    process.stderr.write(`polymerge: ${e.message ?? String(err)}\n`);
    if (process.env.POLYMERGE_DEBUG && e.stack) process.stderr.write(e.stack + '\n');
    process.exitCode = err instanceof UsageError || e.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1;
  },
);
