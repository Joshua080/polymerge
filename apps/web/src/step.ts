/**
 * The optional STEP reader in the browser (decision D51): OpenCascade, compiled to wasm by the
 * `occt-import-js` package (LGPL-2.1, 7.6 MB). It is never bundled with the viewer; it is fetched
 * the first time a STEP file is opened, from one of two places:
 *
 *  1. The page's own server, at vendor/occt-import-js/ — `polymerge view` serves the copy the user
 *     installed next to polymerge there, so nothing is fetched from anywhere else.
 *  2. Otherwise (the hosted viewer), jsDelivr's copy of exactly occt-import-js 0.0.23, ONLY after the
 *     user agrees to the download, and only if both files match the SHA-256 fingerprints pinned
 *     below: a changed file is refused, never run.
 */
import type { IStepImporter } from 'polymerge-core';
import { h } from './dom.js';

export const OCCT_VERSION = '0.0.23';
export const OCCT_CDN = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;
/** SHA-256 of the published occt-import-js 0.0.23 files (npm and jsDelivr serve the same bytes). */
export const OCCT_SHA256: Readonly<Record<'js' | 'wasm', string>> = {
  js: '3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379',
  wasm: '33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952',
};
const LOCAL_DIR = 'vendor/occt-import-js/';
const CONSENT_KEY = 'polymerge.occt-consent';

export class StepReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepReaderError';
  }
}

type Factory = (module?: Record<string, unknown>) => Promise<IStepImporter>;

/** Evaluate the emscripten loader (a classic script that defines `occtimportjs`) and return its factory. */
function factoryFrom(source: string): Factory {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${source}\n;return typeof occtimportjs === 'function' ? occtimportjs : null;`)() as Factory | null;
  if (!factory) throw new StepReaderError('the OpenCascade loader did not define occtimportjs');
  return factory;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new StepReaderError('this page cannot check downloads (it is not served over https)');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The files at `base`, or null when the server has none there (404, or an HTML fallback page). */
async function fetchPair(base: string): Promise<{ js: ArrayBuffer; wasm: ArrayBuffer } | null> {
  const get = async (name: string): Promise<ArrayBuffer | null> => {
    const res = await fetch(new URL(name, base).href);
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
    return res.arrayBuffer();
  };
  const js = await get('occt-import-js.js').catch(() => null);
  if (!js) return null;
  const wasm = await get('occt-import-js.wasm');
  return wasm ? { js, wasm } : null;
}

async function start(files: { js: ArrayBuffer; wasm: ArrayBuffer }): Promise<IStepImporter> {
  const factory = factoryFrom(new TextDecoder().decode(files.js));
  // Hand emscripten the wasm bytes we already have (and checked), so it fetches nothing itself.
  return factory({ wasmBinary: files.wasm });
}

function remembered(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === OCCT_VERSION;
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(CONSENT_KEY, OCCT_VERSION);
  } catch {
    // private window or blocked storage: ask again next time
  }
}

/** Ask before downloading third-party code. Resolves true to go ahead. */
function askConsent(fileName: string): Promise<boolean> {
  if (remembered()) return Promise.resolve(true);
  // A capture (PR images) has nobody to ask.
  if (new URLSearchParams(location.search).has('capture')) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      if (ok && keep.checked) remember();
      dialog.remove();
      resolve(ok);
    };
    const keep = h('input', { type: 'checkbox', checked: true });
    const yes = h('button', { type: 'button', class: 'primary', 'data-action': 'occt-accept' }, 'Download and open');
    const no = h('button', { type: 'button', 'data-action': 'occt-decline' }, 'Cancel');
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    const dialog = h(
      'div',
      { class: 'consent', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'occt-consent-title' },
      h(
        'div',
        { class: 'consent-box' },
        h('h2', { id: 'occt-consent-title' }, 'Open a STEP file?'),
        h(
          'p',
          null,
          `“${fileName}” is a STEP file. Reading it needs OpenCascade (`,
          h('a', { href: 'https://github.com/kovacsv/occt-import-js', target: '_blank', rel: 'noopener' }, `occt-import-js ${OCCT_VERSION}`),
          ', LGPL-2.1): a 7.6 MB download from cdn.jsdelivr.net, checked against a pinned fingerprint before it runs. It runs in this tab; your files are not uploaded.',
        ),
        h('label', { class: 'small' }, keep, ' Don’t ask again in this browser'),
        h('div', { class: 'row buttons' }, yes, no),
      ),
    );
    document.body.append(dialog);
    yes.focus();
  });
}

let loading: Promise<IStepImporter> | null = null;

/** The STEP importer, loaded once per page (see the module comment). */
export function stepImporter(fileName: string): Promise<IStepImporter> {
  loading ??= load(fileName).catch((err: unknown) => {
    loading = null; // allow another try (e.g. after declining)
    throw err;
  });
  return loading;
}

async function load(fileName: string): Promise<IStepImporter> {
  const local = await fetchPair(new URL(LOCAL_DIR, document.baseURI).href);
  if (local) return start(local);
  if (!(await askConsent(fileName))) {
    throw new StepReaderError('Reading STEP files needs the OpenCascade download, which was declined.');
  }
  let files: { js: ArrayBuffer; wasm: ArrayBuffer } | null;
  try {
    files = await fetchPair(OCCT_CDN);
  } catch (err) {
    throw new StepReaderError(`Could not download OpenCascade from cdn.jsdelivr.net: ${(err as Error).message}`);
  }
  if (!files) throw new StepReaderError('Could not download OpenCascade from cdn.jsdelivr.net (not found).');
  const [js, wasm] = await Promise.all([sha256(files.js), sha256(files.wasm)]);
  if (js !== OCCT_SHA256.js || wasm !== OCCT_SHA256.wasm) {
    throw new StepReaderError(`The OpenCascade files from cdn.jsdelivr.net do not match occt-import-js ${OCCT_VERSION}'s fingerprints, so they were not run.`);
  }
  return start(files);
}
