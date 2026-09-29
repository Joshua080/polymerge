/**
 * Process plumbing for the action's scripts: git without a shell, job-log output that untrusted
 * text (file names, parser messages) can never turn into a workflow command, and the runner's
 * output / summary files.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

/**
 * @typedef {{ input?: string | Buffer, env?: Record<string, string>, timeout?: number }} GitOptions
 */

/**
 * Run git with an argument ARRAY (no shell, so paths and refs are never interpreted). Returns
 * stdout (a string, or a Buffer with `encoding: 'buffer'`); throws with git's stderr on failure.
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions & { encoding?: 'utf8' | 'buffer' }} [options]
 * @returns {any}
 */
export function git(cwd, args, { input, encoding = 'utf8', env, timeout = 120_000 } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      encoding: encoding === 'buffer' ? 'buffer' : encoding,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? args[0];
    throw Object.assign(new Error(`git ${sub} failed${stderr ? `: ${stderr}` : `: ${err.message}`}`), { stderr, status: err.status });
  }
}

/**
 * Like git(), but returns { status, stdout, stderr } instead of throwing.
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 */
export function gitTry(cwd, args, { env, timeout = 120_000, input } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

/**
 * Text that is safe to print to the job log: control characters are made visible, and every line
 * is prefixed, so nothing can start a line with `::` (a workflow command such as ::add-mask::).
 */
export function logSafe(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .split('\n')
    .map((line) => `polymerge: ${line}`)
    .join('\n');
}

export function log(...parts) {
  process.stdout.write(`${logSafe(parts.join(' '))}\n`);
}

/** Workflow-command data escaping (the runner's own rules), for annotations. */
function commandData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function warning(message) {
  process.stdout.write(`::warning::${commandData(message)}\n`);
}

export function errorAnnotation(message) {
  process.stdout.write(`::error::${commandData(message)}\n`);
}

/** Append `name=value` to $GITHUB_OUTPUT (a random heredoc delimiter, so values cannot inject). */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `polymerge_${randomBytes(12).toString('hex')}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Append markdown to the job summary ($GITHUB_STEP_SUMMARY), if there is one. */
export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${markdown}\n`);
}

/** A positive integer from the environment (an action input), or the default. */
export function intInput(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number >= 0 (got "${raw}")`);
  return n;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Run `fn` with console output swallowed. The three.js loaders print lines from the file they
 * parse (e.g. "OBJLoader: Unexpected line: …"); model files are untrusted, so none of that may
 * reach the job log.
 */
export async function quietly(fn) {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const noop = () => {};
  Object.assign(console, { log: noop, info: noop, warn: noop, error: noop, debug: noop });
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}
