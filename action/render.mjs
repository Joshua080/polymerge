#!/usr/bin/env node
/**
 * polymerge PR diff, step 1 of 2: render. Finds the model files a pull request changes (from the
 * merge base with the base branch to the head), diffs each with polymerge-core, and renders a
 * before / after card of each with the real viewer in headless Chromium (the capture mode,
 * through scripts/viewer-capture.mjs). Writes
 *
 *   <out>/result.json        what changed (schema: lib/validate.mjs)
 *   <out>/<n>.png            one image per rendered model
 *   <out>/render-log.json    the viewer's capture state per image (panels, cameras); for checks only
 *
 * The pull request's files are only read and parsed; nothing from the pull request is executed.
 *
 *   node action/render.mjs           render (needs `npm run build` and Playwright's Chromium)
 *   node action/render.mjs --list    only list the changed model files: git alone, nothing to
 *                                    install; with none, it writes the (empty) result and stops
 *   node action/render.mjs --probe   exit 0 if headless Chromium starts
 *
 * Environment (action.yml sets it from the inputs):
 *   GITHUB_EVENT_PATH                 the pull_request event (number, base and head commits)
 *   GITHUB_WORKSPACE + POLYMERGE_PATH the checkout to diff
 *   POLYMERGE_OUT                     output directory
 *   POLYMERGE_MAX_FILES (10) · POLYMERGE_MAX_TRIANGLES (200000) · POLYMERGE_MAX_FILE_MB (50)
 *   POLYMERGE_UP_AXIS (auto | y | z) · POLYMERGE_PALETTE (standard | colorblind)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelChanges, modelFormat, parseRawDiff, planWork } from './lib/changes.mjs';
import { appendSummary, errorAnnotation, git, gitTry, intInput, log, quietly, readJson, setOutput } from './lib/io.mjs';
import { matchesPointer, parseLfsPointer, readLocalLfsObject } from './lib/lfs.mjs';
import { buildComment } from './lib/markdown.mjs';
import { hasLocalChanges, summarizeDiff } from './lib/summary.mjs';
import { PALETTES, UP_AXES, validateResult } from './lib/validate.mjs';

const actionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The capture card: 800 CSS px wide (a GitHub comment's width), drawn at 2× for sharp text. */
const CARD = { width: 800, height: 700, scale: 2 };

const args = process.argv.slice(2);

async function probe() {
  const { launchBrowser } = await import('../scripts/viewer-capture.mjs');
  const browser = await launchBrowser();
  await browser.close();
}

/**
 * The base branch commit to diff against. actions/checkout checks out GitHub's test merge of the
 * pull request (refs/pull/N/merge, parents: base, head); its first parent is the base exactly as
 * the "Files changed" tab uses it, while the event's base.sha can be older. Any other checkout
 * falls back to the event's base.sha.
 */
function baseTip(repo, eventBase, head) {
  const [, first, second, extra] = gitTry(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(' ');
  return first && second === head && !extra ? first : eventBase;
}

/** The merge base of the pull request's base and head commits, fetching history if the checkout is shallow. */
function mergeBase(repo, base, head) {
  const find = () => gitTry(repo, ['merge-base', base, head]);
  let mb = find();
  if (mb.status !== 0) {
    const shallow = gitTry(repo, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
    log(`fetching ${shallow ? 'the full history' : 'the base and head commits'} to find the merge base`);
    gitTry(repo, ['fetch', '-q', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin', base, head], { timeout: 600_000 });
    mb = find();
  }
  if (mb.status !== 0) {
    throw new Error(`could not find the merge base of ${base.slice(0, 7)} and ${head.slice(0, 7)} (${mb.stderr}). Check out with \`fetch-depth: 0\` in actions/checkout.`);
  }
  return mb.stdout.trim();
}

/** The content behind an LFS pointer: the local LFS store, else git-lfs (if this checkout uses it), else null. */
function resolveLfs(repo, pointerBytes, pointer) {
  const gitDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const local = readLocalLfsObject(gitDir, pointer);
  if (local) return local;
  if (!fs.existsSync(path.join(gitDir, 'lfs')) || gitTry(repo, ['lfs', 'version']).status !== 0) return null;
  // git-lfs downloads the object with the checkout's credentials.
  const r = spawnSync('git', ['lfs', 'smudge'], { cwd: repo, input: pointerBytes, maxBuffer: 1024 * 1024 * 1024, timeout: 300_000 });
  return r.status === 0 && r.stdout && matchesPointer(r.stdout, pointer) ? r.stdout : null;
}

/** @type {Promise<import('polymerge-core').IStepImporter> | null} */
let occt = null;

/**
 * OpenCascade for STEP files: occt-import-js (LGPL-2.1), installed with this action's own
 * dependencies and started on the first STEP file. It runs only in this Node process: the images
 * are rendered from the tessellated meshes, so the browser never downloads it.
 */
function stepImporter() {
  /** @type {Promise<import('polymerge-core').IStepImporter>} */
  const started = (occt ??= createRequire(path.join(actionRoot, 'package.json'))('occt-import-js')());
  return started;
}

/** An input that must be one of `choices` (empty = the default); anything else stops the run. */
function choiceInput(name, choices, fallback) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (!choices.includes(raw)) throw new Error(`${name.replace('POLYMERGE_', '').toLowerCase().replace(/_/g, '-')} must be one of ${choices.join(', ')} (got "${raw}")`);
  return raw;
}

function message(err) {
  const text = err instanceof Error ? (err.name && !['Error', 'MeshLoadError'].includes(err.name) ? `${err.name}: ${err.message}` : err.message) : String(err);
  return text.slice(0, 900);
}

/**
 * @typedef {{ blob: string, path: string, format?: string | null, bytes?: Buffer, mesh?: import('polymerge-core').IMesh }} Side
 */

/** The viewer server and headless Chromium, started on the first model that needs an image. */
class Renderer {
  /** @type {Awaited<ReturnType<typeof import('../scripts/viewer-capture.mjs').startViewer>> | null} */
  viewer = null;
  /** @type {import('playwright').Browser | null} */
  browser = null;

  /** The running server and a connected browser (a crashed browser is replaced). */
  async ready() {
    const { startViewer, launchBrowser } = await import('../scripts/viewer-capture.mjs');
    this.viewer ??= await startViewer();
    if (!this.browser?.isConnected()) {
      await this.browser?.close().catch(() => {});
      this.browser = await launchBrowser();
    }
    return { viewer: this.viewer, browser: this.browser };
  }

  /**
   * Render one card to `file`; resolves the viewer's hook (with its capture state).
   * @param {{ before: Side | null, after: Side | null, labels: { before: string, after: string }, file: string, up: 'y' | 'z', palette: string }} job
   */
  async card({ before, after, labels, file, up, palette }) {
    const { bounded, readHook, waitReady } = await import('../scripts/viewer-capture.mjs');
    const { viewer, browser } = await this.ready();
    const context = await bounded(browser.newContext({ viewport: { width: CARD.width, height: CARD.height }, deviceScaleFactor: CARD.scale }), 30_000, 'open a browser context');
    try {
      const page = await bounded(context.newPage(), 30_000, 'open a page');
      page.setDefaultTimeout(60_000);
      // The model bytes are served to the page by Playwright under fixed names: no temp files, and
      // nothing from the pull request (not even a file name) goes into a URL.
      /** @type {Map<string, Buffer>} */
      const served = new Map();
      const query = new URLSearchParams({ capture: '1', before: labels.before, after: labels.after, up, palette });
      for (const [key, side] of /** @type {const} */ ([['base', before], ['target', after]])) {
        if (!side?.bytes) continue;
        const urlPath = `/__polymerge/${key}.${side.format}`;
        served.set(urlPath, side.bytes);
        query.set(key, urlPath);
      }
      await page.route('**/__polymerge/**', (route) => {
        const body = served.get(new URL(route.request().url()).pathname);
        return body ? route.fulfill({ status: 200, contentType: 'application/octet-stream', body }) : route.fulfill({ status: 404, body: 'not found' });
      });
      const crashed = new Promise((_, reject) => page.once('crash', () => reject(new Error('the browser page crashed'))));
      crashed.catch(() => {});
      await Promise.race([page.goto(`${viewer.origin}/?${query}`), crashed]);
      const state = await Promise.race([waitReady(page, { allowError: true, timeout: 150_000 }), crashed]);
      const hook = await readHook(page);
      if (state !== 'ready') throw new Error(hook?.error ?? 'the viewer did not finish');
      await page.locator('#capture').screenshot({ path: file, timeout: 60_000 });
      return hook;
    } finally {
      await bounded(context.close(), 15_000, 'close the browser context').catch(() => {});
    }
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.viewer?.stop();
  }
}

async function main() {
  if (args.includes('--probe')) {
    // A failure here is expected on a runner without Chromium's system libraries: action.yml
    // installs them next, so this is a log line, not an error annotation.
    return probe().catch((err) => {
      log(`Chromium does not start yet (${message(err).split('\n')[0]})`);
      process.exit(1);
    });
  }
  const listOnly = args.includes('--list');

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? readJson(eventPath) : {};
  const pull = event.pull_request;
  if (!pull) throw new Error('this action renders pull requests: run it on a pull_request event');
  const number = pull.number;
  const baseSha = pull.base?.sha;
  const headSha = pull.head?.sha;
  if (!Number.isSafeInteger(number) || !SHA.test(baseSha ?? '') || !SHA.test(headSha ?? '')) throw new Error('the event has no pull request number / base / head commit');

  const repo = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.env.POLYMERGE_PATH || '.');
  const out = path.resolve(process.env.POLYMERGE_OUT || 'polymerge-pr-diff');
  const view = { upAxis: choiceInput('POLYMERGE_UP_AXIS', UP_AXES, 'auto'), palette: choiceInput('POLYMERGE_PALETTE', PALETTES, 'standard') };
  const limits = {
    maxFiles: intInput('POLYMERGE_MAX_FILES', 10),
    maxFaces: intInput('POLYMERGE_MAX_TRIANGLES', 200_000),
    maxBytes: intInput('POLYMERGE_MAX_FILE_MB', 50) * 1024 * 1024,
  };

  const base = mergeBase(repo, baseTip(repo, baseSha, headSha), headSha);
  const raw = git(repo, ['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', '--no-color', base, headSha]);
  const plan = planWork(modelChanges(parseRawDiff(raw)), limits.maxFiles);
  log(`${plan.length} model file(s) changed between the merge base ${base.slice(0, 7)} and ${headSha.slice(0, 7)}`);
  setOutput('count', String(plan.length));
  setOutput('result-dir', out);

  const version = readJson(path.join(actionRoot, 'packages/cli/package.json')).version;
  /** @type {import('./lib/validate.mjs').RenderResult} */
  const result = { schema: 1, tool: `polymerge ${version}`, pr: number, base, head: headSha, limits, files: [], ...view };
  const write = (captures = []) => {
    validateResult(result); // the post step will insist on it; fail here first, with our own bug
    fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'render-log.json'), `${JSON.stringify(captures, null, 2)}\n`);
  };
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  if (listOnly) {
    if (plan.length === 0) write();
    return;
  }

  const { diffMeshes, loadMesh, stepInfo, writeGlb } = await import('polymerge-core');
  const silent = { info() {}, warn() {} };
  const renderer = new Renderer();
  /** @type {{ image: string, path: string, tier: number | null, stats: unknown, capture: unknown }[]} */
  const captures = [];
  const labels = { before: base.slice(0, 7), after: headSha.slice(0, 7) };
  try {
    for (const c of plan) {
      /** @type {import('./lib/validate.mjs').FileResult} */
      const entry = { path: c.path, oldPath: c.oldPath, change: c.change, status: 'error', image: null, error: null, modeChanged: c.modeChanged, mesh: { before: null, after: null }, limit: null, diff: null };
      result.files.push(entry);
      if (c.skip) entry.status = 'skipped';
      else if (c.identical) entry.status = 'same-content';
      else if (c.overLimit) entry.status = 'not-rendered';
      if (entry.status !== 'error') continue;
      const started = Date.now();
      try {
        // 1. Read both versions (size cap, LFS pointers), then parse them.
        /** @type {{ before: Side | null, after: Side | null }} */
        const sides = { before: c.before ? { blob: c.before, path: c.oldPath ?? c.path } : null, after: c.after ? { blob: c.after, path: c.path } : null };
        const both = !!(sides.before && sides.after);
        let stop = null;
        // STEP: the after version is tessellated with the before version's tolerance, so that
        // surfaces that did not change get the same triangles.
        let stepDeflection;
        for (const [key, side] of Object.entries(sides)) {
          if (!side || stop) continue;
          const size = Number(git(repo, ['cat-file', '-s', side.blob]).trim());
          if (size > limits.maxBytes) {
            stop = { status: 'too-large', limit: { what: 'bytes', value: size, max: limits.maxBytes } };
            continue;
          }
          let bytes = git(repo, ['cat-file', 'blob', side.blob], { encoding: 'buffer' });
          const pointer = parseLfsPointer(bytes);
          if (pointer) {
            bytes = resolveLfs(repo, bytes, pointer);
            if (!bytes) {
              stop = { status: 'lfs' };
              continue;
            }
            if (bytes.length > limits.maxBytes) {
              stop = { status: 'too-large', limit: { what: 'bytes', value: bytes.length, max: limits.maxBytes } };
              continue;
            }
          }
          const format = modelFormat(side.path) ?? undefined;
          let mesh;
          try {
            const step = format === 'step' ? { importer: await stepImporter(), deflection: stepDeflection } : undefined;
            mesh = await quietly(() => loadMesh(bytes, { fileName: path.posix.basename(side.path), format, step }));
          } catch (err) {
            stop = { status: 'error', error: `${both ? `${key}: ` : ''}${message(err)}` };
            continue;
          }
          if (format === 'step') {
            stepDeflection ??= stepInfo(mesh)?.deflection;
            // The page gets the tessellated mesh as GLB (exact: positions are float32 either way). A
            // Buffer, like git's blobs: Playwright's route.fulfill does not take a bare Uint8Array.
            Object.assign(side, { format: 'glb', bytes: Buffer.from(writeGlb(mesh)), mesh });
          } else Object.assign(side, { format, bytes, mesh });
          entry.mesh[key] = { vertices: mesh.vertexCount, faces: mesh.faceCount };
          if (mesh.faceCount > limits.maxFaces) stop = { status: 'too-large', limit: { what: 'faces', value: mesh.faceCount, max: limits.maxFaces } };
        }
        if (stop) {
          Object.assign(entry, stop);
          log(`${c.path}: ${entry.status}${entry.error ? ` (${entry.error})` : ''}`);
          continue;
        }
        // 2. Diff (both versions present).
        const [beforeMesh, afterMesh] = [sides.before?.mesh, sides.after?.mesh];
        if (beforeMesh && afterMesh) {
          const diff = await quietly(() => diffMeshes(beforeMesh, afterMesh, { logger: silent }));
          entry.diff = summarizeDiff(diff, { named: beforeMesh.groups.length > 1 || afterMesh.groups.length > 1 });
          if (!hasLocalChanges(entry.diff)) {
            entry.status = 'same-geometry';
            log(`${c.path}: same geometry (Tier ${diff.tier})`);
            continue;
          }
        }
        // 3. Render.
        const image = `${captures.length}.png`;
        try {
          // auto: Z up for STEP (the CAD convention; the page gets GLB, so it cannot tell), Y otherwise.
          const up = view.upAxis === 'auto' ? (modelFormat(c.path) === 'step' || modelFormat(c.oldPath) === 'step' ? 'z' : 'y') : view.upAxis;
          const hook = await renderer.card({ before: sides.before, after: sides.after, labels, file: path.join(out, image), up, palette: view.palette });
          entry.status = 'rendered';
          entry.image = image;
          captures.push({ image, path: c.path, tier: hook.tier ?? null, stats: hook.stats ?? null, view: hook.view ?? null, capture: hook.capture });
          if (entry.diff && hook.tier !== entry.diff.tier) log(`${c.path}: note: the viewer matched with Tier ${hook.tier}, the summary with Tier ${entry.diff.tier}`);
        } catch (err) {
          entry.status = 'render-failed';
          entry.error = message(err);
        }
        log(`${c.path}: ${entry.status}${entry.diff ? ` (Tier ${entry.diff.tier})` : ''} in ${((Date.now() - started) / 1000).toFixed(1)} s${entry.error ? `: ${entry.error}` : ''}`);
      } catch (err) {
        entry.status = 'error';
        entry.error = message(err);
        log(`${c.path}: error: ${entry.error}`);
      }
    }
  } finally {
    await renderer.close();
  }
  write(captures);
  setOutput('rendered', String(captures.length));
  appendSummary(`${buildComment(validateResult(result))}\n\n<sub>Preview from the render step: the images are published with the comment.</sub>`);
  log(`wrote ${path.join(out, 'result.json')} and ${captures.length} image(s)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    errorAnnotation(`polymerge: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
