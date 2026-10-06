/**
 * `polymerge init [--global] [--dry-run]` — set git up for polymerge in one go, instead of copying
 * the lines `polymerge git-setup` prints:
 *
 *   polymerge init            this repository: .gitattributes at its root (commit it, so everyone
 *                             gets it) and the drivers in .git/config;
 *   polymerge init --global   every repository of this user: the global attributes file (git's
 *                             core.attributesFile, else ~/.config/git/attributes) and ~/.gitconfig.
 *
 * Safe to run again: it adds only what is missing. A line or setting you already have with a
 * different value is kept, and reported, never overwritten.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { palette } from '../report.js';
import { GIT_ATTRIBUTES, GIT_CONFIG } from './git.js';

export interface InitOptions {
  global?: boolean;
  dryRun?: boolean;
  /** Where to run (default: the current directory). */
  cwd?: string;
}

type Change = { mark: '+' | '=' | '!'; text: string; note?: string };

const HEADER = '# polymerge: structural diff and three-way merge for 3D models (written by polymerge init)';

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '') };
  } catch (err) {
    const e = err as { status?: number; code?: string; stderr?: string };
    if (e.code === 'ENOENT') throw new Error('git is not installed (or not on PATH)');
    return { ok: false, out: String(e.stderr ?? '') };
  }
}

/** The global attributes file git reads: core.attributesFile, else $XDG_CONFIG_HOME/git/attributes. */
function globalAttributesFile(cwd: string): string {
  const configured = git(cwd, ['config', '--global', '--get', 'core.attributesFile']);
  if (configured.ok && configured.out) return configured.out.replace(/^~(?=$|[\\/])/, os.homedir());
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'git', 'attributes');
}

/** The pattern a .gitattributes line is for (null for blanks and comments). */
function patternOf(line: string): string | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  return t.split(/\s+/)[0];
}

/** Plan the attributes file: lines to add, and what is already there. */
export function planAttributes(existing: string): { add: string[]; changes: Change[] } {
  const lines = existing.split(/\r?\n/);
  const byPattern = new Map<string, string>();
  for (const line of lines) {
    const p = patternOf(line);
    if (p) byPattern.set(p, line.trim().split(/\s+/).slice(1).join(' ')); // the last line for a pattern wins in git
  }
  const add: string[] = [];
  const changes: Change[] = [];
  for (const { pattern, attributes } of GIT_ATTRIBUTES) {
    const wanted = `${pattern} ${attributes}`;
    const have = byPattern.get(pattern);
    if (have === undefined) {
      add.push(wanted);
      changes.push({ mark: '+', text: wanted });
    } else if (have === attributes) {
      changes.push({ mark: '=', text: wanted, note: 'already there' });
    } else {
      changes.push({ mark: '!', text: `${pattern} ${have}`, note: `kept your line; polymerge's would be "${wanted}"` });
    }
  }
  return { add, changes };
}

/** The attributes file with `add` appended (under a one-line header). */
export function withAttributes(existing: string, add: readonly string[]): string {
  if (add.length === 0) return existing;
  const body = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  const header = body.includes(HEADER) ? [] : [...(body.trim() ? [''] : []), HEADER];
  return `${body}${[...header, ...add].join('\n')}\n`;
}

/** Is `polymerge` a command git can run (on PATH)? */
function onPath(): boolean {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, `polymerge${ext.toLowerCase()}`);
      try {
        if (statSync(file).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

export async function runInit(o: InitOptions = {}): Promise<number> {
  const cwd = o.cwd ?? process.cwd();
  const c = palette();
  const scope = o.global ? '--global' : '--local';
  let attributesFile: string;
  let where: string;
  if (o.global) {
    attributesFile = globalAttributesFile(cwd);
    where = 'every repository of this user';
  } else {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!top.ok) throw new Error('not inside a git repository. Run it in one, or use --global to set git up for all your repositories');
    attributesFile = path.join(top.out, '.gitattributes');
    where = `this repository (${top.out})`;
  }

  // 1. Attributes.
  const existing = existsSync(attributesFile) ? readFileSync(attributesFile, 'utf8') : '';
  const attrs = planAttributes(existing);

  // 2. Config.
  const configChanges: Change[] = [];
  const configToSet: [string, string][] = [];
  for (const [key, value] of GIT_CONFIG) {
    const have = git(cwd, ['config', scope, '--get', key]);
    if (!have.ok || have.out === '') {
      configToSet.push([key, value]);
      configChanges.push({ mark: '+', text: `${key} = ${value}` });
    } else if (have.out === value) {
      configChanges.push({ mark: '=', text: `${key} = ${value}`, note: 'already set' });
    } else {
      configChanges.push({ mark: '!', text: `${key} = ${have.out}`, note: `kept your setting; polymerge's would be "${value}"` });
    }
  }

  if (!o.dryRun) {
    if (attrs.add.length > 0) {
      mkdirSync(path.dirname(attributesFile), { recursive: true });
      writeFileSync(attributesFile, withAttributes(existing, attrs.add));
    }
    for (const [key, value] of configToSet) {
      const r = git(cwd, ['config', scope, key, value]);
      if (!r.ok) throw new Error(`git config ${scope} ${key} failed: ${r.out.trim()}`);
    }
  }

  const show = (ch: Change): string => {
    const label = (ch.mark === '+' ? (o.dryRun ? '+ would add' : '+ added') : ch.mark === '=' ? '= present' : '! kept').padEnd(11);
    const mark = ch.mark === '+' ? c.added(label) : ch.mark === '=' ? c.dim(label) : c.modified(label);
    return `    ${mark} ${ch.text}${ch.note ? c.dim(`  (${ch.note})`) : ''}`;
  };
  const configName = o.global ? '~/.gitconfig' : '.git/config';
  const out = [
    c.bold(`polymerge init${o.dryRun ? ' (dry run: nothing written)' : ''}: ${where}`),
    `  ${o.global ? attributesFile : '.gitattributes'}`,
    ...attrs.changes.map(show),
    `  git config (${configName})`,
    ...configChanges.map(show),
  ];
  const added = attrs.add.length + configToSet.length;
  out.push('');
  if (added === 0) out.push('Nothing to do: git is already set up for polymerge here.');
  else if (!o.dryRun) {
    out.push(o.global ? 'Done. git now uses polymerge for 3D models in every repository.' : 'Done. Commit .gitattributes so everyone who clones the repository gets it; each person runs "polymerge init" once (or "polymerge init --global") for the drivers.');
  }
  out.push('Try: git diff -- <model>.stl    git log -p --ext-diff -- <model>.stl    git difftool -t polymerge -- <model>.stl');
  if (!onPath()) {
    out.push(
      c.modified('Note: git runs "polymerge" by name, and it is not on your PATH (npx does not put it there).'),
      c.modified('      Install it so git can find it: npm install -g @joshuahurley/polymerge'),
    );
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}
