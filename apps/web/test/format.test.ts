/** The panel's "Loaded from" helper: which models say where they came from. */
import { describe, expect, it } from 'vitest';
import { fmtSource } from '../src/format.js';

describe('fmtSource', () => {
  const page = 'joshua080.github.io';

  it('names the host of a model fetched from another site', () => {
    expect(fmtSource('https://raw.githubusercontent.com/o/r/sha/part.stl', page)).toBe('raw.githubusercontent.com');
    expect(fmtSource('http://models.example.org:8080/a/b.glb', page)).toBe('models.example.org:8080');
  });

  it('says nothing for the page\'s own host, local files and built-in examples', () => {
    expect(fmtSource('https://joshua080.github.io/polymerge/fixtures/x.stl', page)).toBeNull();
    expect(fmtSource('/models/base/part.stl', page)).toBeNull();
    expect(fmtSource('fixtures/cases/a/base.obj', page)).toBeNull();
    expect(fmtSource('plate.stl', page)).toBeNull();
    expect(fmtSource('mock', page)).toBeNull();
    expect(fmtSource('example', page)).toBeNull();
    expect(fmtSource(undefined, page)).toBeNull();
  });

  it('ignores addresses that are not http(s)', () => {
    expect(fmtSource('data:model/stl;base64,AAAA', page)).toBeNull();
    expect(fmtSource('file:///tmp/a.stl', page)).toBeNull();
    expect(fmtSource('javascript:alert(1)', page)).toBeNull();
  });
});
