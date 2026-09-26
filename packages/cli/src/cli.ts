#!/usr/bin/env node
/**
 * polymerge CLI — vertex-level correspondence diff for 3D models.
 *
 *   polymerge diff <base> <target> [--json <file|->] [--force-tier 1|2|3] ...
 *   polymerge view <base> <target> [--port N] [--no-open]
 *   polymerge info <file>
 *   polymerge merge <base> <ours> <theirs> [-o merged.stl] [--resolve ours|theirs|base] [--pick id=side]
 *   polymerge git-diff <git external-diff args...>
 *   polymerge git-merge %O %A %B %P
 *   polymerge git-setup
 */
import { parseArgs } from 'node:util';
import { runDiff } from './commands/diff.js';
import { gitSetupText, runGitDiff } from './commands/git.js';
import { runInfo } from './commands/info.js';
import { runGitMerge, runGitResolve, runMerge } from './commands/merge.js';
import { runView } from './commands/view.js';

const VERSION = '0.1.0';

const HELP = `polymerge ${VERSION} — structural (vertex-correspondence) diff for STL, OBJ, glTF/GLB

Usage:
  polymerge diff <base> <target> [options]   Diff two models and print a report
      --json <file|->        Also write the full diff result as JSON ("-" = stdout)
      --force-tier <1|2|3>   Run only this correspondence tier
      --move-eps <n>         Displacement above which a vertex counts as moved
      --surface-tol <n>      Tier 3 surface distance above which geometry is added/removed
      --top <n>              How many individual vertex moves to list (default 10)
      --exit-code            Exit 1 when the models differ (like git diff --exit-code)
      -q, --quiet            No report or engine log (useful with --json)
      -v, --verbose          Include engine debug logging
  polymerge view <base> <target> [options]   Open the interactive 3D diff in the browser
      --port <n>             Port (default 5178, falls back to a free port)
      --host <addr>          Bind address (default 127.0.0.1)
      --name <file>          Display name for both sides (git difftool passes $MERGED)
      --no-open              Do not launch a browser, just print the URL
      --web-dist <dir>       Path to the built viewer (default: apps/web/dist)
  polymerge merge <base> <ours> <theirs> [options]   Three-way merge (exit 1 = unresolved conflicts)
      -o, --output <file>    Write the merged model (.stl or .obj)
      --resolve <side>       Resolve every conflict with ours | theirs | base
      --pick <id>=<side>     Resolve one conflict (repeatable), e.g. --pick 0=theirs
      --report <file>        Write the conflicts and statistics as JSON
      --no-collision-check   Don't check the combined edits for surfaces passing through each other
      -q, --quiet            No report
  polymerge resolve <path> --pick <id>=<side> | --resolve <side>
                                             Finish a conflicted git merge of <path> (reads git's index stages)
  polymerge info <file>                      Print the normalised mesh summary
  polymerge git-diff <7 git args>            git external diff driver (diff.<name>.command)
  polymerge git-merge %O %A %B %P            git merge driver (merge.<name>.driver)
  polymerge git-setup                        Print the git configuration snippet
  polymerge --version | --help
`;

async function main(argv: string[]): Promise<number> {
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
        },
      });
      requirePositionals('view', positionals, 2);
      return runView(positionals[0], positionals[1], {
        port: values.port,
        host: values.host,
        open: !values['no-open'],
        webDist: values['web-dist'],
        baseName: values.name,
        targetName: values.name,
      });
    }
    case 'info': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      requirePositionals('info', positionals, 1);
      return runInfo(positionals[0]);
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
        },
      });
      requirePositionals('resolve', positionals, 1);
      return runGitResolve(positionals[0], {
        resolve: values.resolve,
        pick: values.pick,
        format: values.format,
        quiet: values.quiet,
        collisionCheck: !values['no-collision-check'],
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
    default:
      process.stderr.write(`polymerge: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
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
