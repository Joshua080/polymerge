/**
 * Git LFS. A file tracked by LFS is stored in git as a small pointer text
 * (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md):
 *
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
 *   size 12345
 *
 * Reading a commit's blob always yields the pointer, whether or not the checkout fetched LFS
 * content, so it is recognised here instead of being handed to a mesh parser.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Pointer files are small by definition (the spec caps them below 1024 bytes). */
const MAX_POINTER_BYTES = 1024;
const VERSIONS = ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1'];

/** { oid, size } when `bytes` is an LFS pointer, else null. */
export function parseLfsPointer(bytes) {
  if (!bytes || bytes.length === 0 || bytes.length >= MAX_POINTER_BYTES) return null;
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.startsWith('version ')) return null;
  const lines = text.split('\n').filter((l) => l !== '');
  const version = /^version (\S+)$/.exec(lines[0] ?? '');
  if (!version || !VERSIONS.includes(version[1])) return null;
  let oid = null;
  let size = null;
  for (const line of lines.slice(1)) {
    const o = /^oid sha256:([0-9a-f]{64})$/.exec(line);
    const s = /^size (\d+)$/.exec(line);
    if (o) oid = o[1];
    else if (s) size = Number(s[1]);
    else if (!/^ext-\d+-[a-z0-9.-]+ \S+$/.test(line)) return null; // the only other lines the spec allows
  }
  return oid && size !== null && Number.isSafeInteger(size) ? { oid, size } : null;
}

/** Where git-lfs keeps an object locally: <git dir>/lfs/objects/aa/bb/<oid>. */
export function lfsObjectPath(gitDir, oid) {
  return path.join(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** True when `bytes` is exactly the content a pointer names (size and SHA-256). */
export function matchesPointer(bytes, pointer) {
  return bytes.length === pointer.size && createHash('sha256').update(bytes).digest('hex') === pointer.oid;
}

/** The pointer's content from the local LFS store (filled by `actions/checkout` with `lfs: true`), or null. */
export function readLocalLfsObject(gitDir, pointer) {
  const file = lfsObjectPath(gitDir, pointer.oid);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== pointer.size) return null;
    const bytes = fs.readFileSync(file);
    return matchesPointer(bytes, pointer) ? bytes : null;
  } catch {
    return null;
  }
}
