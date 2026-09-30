/**
 * Which model files a pull request changes, from `git diff --raw -z` between the merge base and
 * the head. Pure functions (no git, no fs), unit-tested in action/test/changes.test.ts.
 */

export const MODEL_EXTENSIONS = ['stl', 'obj', 'gltf', 'glb'];

const SYMLINK = '120000';
const GITLINK = '160000';
const NONE = '000000';

/**
 * The model format a path's extension names (case-insensitive), or null.
 * @param {string | null | undefined} path
 * @returns {'stl' | 'obj' | 'gltf' | 'glb' | null}
 */
export function modelFormat(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path ?? '');
  const ext = m ? m[1].toLowerCase() : '';
  return MODEL_EXTENSIONS.includes(ext) ? /** @type {'stl' | 'obj' | 'gltf' | 'glb'} */ (ext) : null;
}

/**
 * Parse `git diff --raw -z --no-abbrev -M <a> <b>`. Each record is
 * `:<old mode> <new mode> <old blob> <new blob> <status>[score]\0<path>\0`, with a second path for
 * renames and copies. With -z git quotes nothing, so a name may hold any character but NUL
 * (newlines included).
 */
export function parseRawDiff(text) {
  const tokens = text.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++];
    if (head === '' || head === '\n') continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/.exec(head);
    if (!m) throw new Error(`unexpected git diff --raw record: ${JSON.stringify(head.slice(0, 80))}`);
    const [, oldMode, newMode, oldBlob, newBlob, status, score] = m;
    const two = status === 'R' || status === 'C';
    const first = tokens[i++];
    const second = two ? tokens[i++] : first;
    if (first === undefined || second === undefined) throw new Error('truncated git diff --raw output');
    entries.push({ status, score: score ? Number(score) : null, oldMode, newMode, oldBlob, newBlob, oldPath: first, path: second });
  }
  return entries;
}

/**
 * The changed model files, one entry each, sorted by path:
 *   change      'added' | 'deleted' | 'modified' | 'renamed'
 *   path        the path in the head (for a deleted file: the path it had)
 *   oldPath     the path in the merge base, for renames (else null)
 *   before, after   blob ids (null on the side where the file does not exist)
 *   identical   same content on both sides (a pure rename, or only the file mode changed)
 *   skip        why it cannot be read as a model (a symbolic link), else null
 * A rename between a model and a non-model path counts as the model being deleted or added.
 * Submodules are not files and are left out.
 */
export function modelChanges(entries) {
  const out = [];
  for (const e of entries) {
    if (e.oldMode === GITLINK || e.newMode === GITLINK) continue;
    const oldIsModel = modelFormat(e.oldPath) !== null;
    const newIsModel = modelFormat(e.path) !== null;
    const blob = (id) => (/^0+$/.test(id) ? null : id);
    let c;
    if (e.status === 'A' && newIsModel) c = { change: 'added', path: e.path, before: null, after: blob(e.newBlob), oldMode: NONE, newMode: e.newMode };
    else if (e.status === 'D' && oldIsModel) c = { change: 'deleted', path: e.path, before: blob(e.oldBlob), after: null, oldMode: e.oldMode, newMode: NONE };
    else if ((e.status === 'M' || e.status === 'T') && newIsModel) c = { change: 'modified', path: e.path, before: blob(e.oldBlob), after: blob(e.newBlob), oldMode: e.oldMode, newMode: e.newMode };
    else if (e.status === 'R' && oldIsModel && newIsModel) c = { change: 'renamed', path: e.path, oldPath: e.oldPath, before: blob(e.oldBlob), after: blob(e.newBlob), oldMode: e.oldMode, newMode: e.newMode };
    else if ((e.status === 'R' || e.status === 'C') && newIsModel) c = { change: 'added', path: e.path, before: null, after: blob(e.newBlob), oldMode: NONE, newMode: e.newMode };
    else if (e.status === 'R' && oldIsModel) c = { change: 'deleted', path: e.oldPath, before: blob(e.oldBlob), after: null, oldMode: e.oldMode, newMode: NONE };
    else continue;
    const symlink = c.oldMode === SYMLINK || c.newMode === SYMLINK;
    out.push({
      change: c.change,
      path: c.path,
      oldPath: c.oldPath ?? null,
      before: c.before,
      after: c.after,
      identical: c.before !== null && c.before === c.after,
      modeChanged: c.change !== 'added' && c.change !== 'deleted' && c.oldMode !== c.newMode,
      skip: symlink ? 'a symbolic link, not a file' : null,
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Decide what is diffed and rendered. Files whose content changed are rendered in path order, up
 * to `maxFiles`; the rest are only listed (`overLimit`). Identical-content and unreadable entries
 * cost nothing and never count toward the cap.
 */
export function planWork(changes, maxFiles) {
  let budget = maxFiles;
  return changes.map((c) => {
    const work = !c.identical && !c.skip;
    const render = work && budget > 0;
    if (render) budget--;
    return { ...c, render, overLimit: work && !render };
  });
}
