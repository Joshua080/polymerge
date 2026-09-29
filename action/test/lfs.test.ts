import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lfsObjectPath, parseLfsPointer, readLocalLfsObject } from '../lib/lfs.mjs';

const OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';
const pointer = (lines: string[]) => Buffer.from(`${lines.join('\n')}\n`);

describe('parseLfsPointer', () => {
  it('reads a pointer file (spec v1, and the legacy hawser version)', () => {
    expect(parseLfsPointer(pointer(['version https://git-lfs.github.com/spec/v1', `oid sha256:${OID}`, 'size 12345']))).toEqual({ oid: OID, size: 12345 });
    expect(parseLfsPointer(pointer(['version https://hawser.github.com/spec/v1', `oid sha256:${OID}`, 'size 0']))).toEqual({ oid: OID, size: 0 });
  });

  it('allows extension lines', () => {
    expect(parseLfsPointer(pointer(['version https://git-lfs.github.com/spec/v1', 'ext-0-foo sha256:abc', `oid sha256:${OID}`, 'size 7']))).toEqual({ oid: OID, size: 7 });
  });

  it('rejects anything else', () => {
    const cases = [
      pointer(['version https://example.com/spec/v1', `oid sha256:${OID}`, 'size 1']), // unknown version
      pointer(['version https://git-lfs.github.com/spec/v1', 'size 1']), // no oid
      pointer(['version https://git-lfs.github.com/spec/v1', `oid sha256:${OID}`]), // no size
      pointer(['version https://git-lfs.github.com/spec/v1', `oid sha256:${OID.slice(1)}`, 'size 1']), // short oid
      pointer(['version https://git-lfs.github.com/spec/v1', `oid sha256:${OID}`, 'size 1', 'v 0 0 0']), // model data after it
      Buffer.from(`solid part\nfacet normal 0 0 1\n`), // an ASCII STL
      Buffer.concat([pointer(['version https://git-lfs.github.com/spec/v1', `oid sha256:${OID}`, 'size 1']), Buffer.alloc(1100, 32)]), // too long
      Buffer.alloc(0),
    ];
    for (const c of cases) expect(parseLfsPointer(c)).toBeNull();
  });
});

describe('readLocalLfsObject', () => {
  it('returns the object from <git dir>/lfs/objects only when its size and hash match', () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-lfs-'));
    try {
      const content = Buffer.from('solid x\nendsolid x\n');
      const oid = createHash('sha256').update(content).digest('hex');
      const file = lfsObjectPath(gitDir, oid);
      expect(path.relative(gitDir, file)).toBe(path.join('lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
      expect(readLocalLfsObject(gitDir, { oid, size: content.length })).toBeNull(); // not fetched
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      expect(readLocalLfsObject(gitDir, { oid, size: content.length })?.equals(content)).toBe(true);
      expect(readLocalLfsObject(gitDir, { oid, size: content.length + 1 })).toBeNull();
      fs.writeFileSync(file, Buffer.from('solid y\nendsolid y\n')); // same size, other content
      expect(readLocalLfsObject(gitDir, { oid, size: content.length })).toBeNull();
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });
});
