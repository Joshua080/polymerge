/**
 * Connected components ("parts") of a triangle mesh: vertices connected through faces.
 * Components are numbered in order of their smallest vertex index (deterministic), and
 * member vertex / face lists are CSR, ascending.
 */

export interface IComponents {
  count: number;
  /** Component id per vertex (isolated vertices form their own singleton component). */
  id: Int32Array;
  /** Member vertices of component c: vertices[vertexOffsets[c] .. vertexOffsets[c + 1]). */
  vertexOffsets: Uint32Array;
  vertices: Uint32Array;
  /** Member faces of component c: faces[faceOffsets[c] .. faceOffsets[c + 1]). */
  faceOffsets: Uint32Array;
  faces: Uint32Array;
}

export function buildComponents(vertexCount: number, faces: Uint32Array): IComponents {
  const parent = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) parent[v] = v;
  // Union by smaller root (so a component's root is its smallest vertex), path halving.
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 1; k < 3; k++) {
      let a = faces[f];
      let b = faces[f + k];
      while (parent[a] !== a) a = parent[a] = parent[parent[a]];
      while (parent[b] !== b) b = parent[b] = parent[parent[b]];
      if (a === b) continue;
      if (a < b) parent[b] = a;
      else parent[a] = b;
    }
  }
  const find = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  const id = new Int32Array(vertexCount).fill(-1);
  let count = 0;
  const rootId = new Int32Array(vertexCount).fill(-1);
  for (let v = 0; v < vertexCount; v++) {
    const r = find(v);
    if (rootId[r] < 0) rootId[r] = count++;
    id[v] = rootId[r];
  }
  const vertexOffsets = new Uint32Array(count + 1);
  for (let v = 0; v < vertexCount; v++) vertexOffsets[id[v] + 1]++;
  for (let c = 0; c < count; c++) vertexOffsets[c + 1] += vertexOffsets[c];
  const vertices = new Uint32Array(vertexCount);
  const fillV = vertexOffsets.slice(0, count);
  for (let v = 0; v < vertexCount; v++) vertices[fillV[id[v]]++] = v;
  const faceCount = faces.length / 3;
  const faceOffsets = new Uint32Array(count + 1);
  for (let f = 0; f < faceCount; f++) faceOffsets[id[faces[f * 3]] + 1]++;
  for (let c = 0; c < count; c++) faceOffsets[c + 1] += faceOffsets[c];
  const faceList = new Uint32Array(faceCount);
  const fillF = faceOffsets.slice(0, count);
  for (let f = 0; f < faceCount; f++) faceList[fillF[id[faces[f * 3]]]++] = f;
  return { count, id, vertexOffsets, vertices, faceOffsets, faces: faceList };
}

export function componentSize(cc: IComponents, c: number): number {
  return cc.vertexOffsets[c + 1] - cc.vertexOffsets[c];
}

export function componentVertices(cc: IComponents, c: number): Uint32Array {
  return cc.vertices.subarray(cc.vertexOffsets[c], cc.vertexOffsets[c + 1]);
}

export function componentFaces(cc: IComponents, c: number): Uint32Array {
  return cc.faces.subarray(cc.faceOffsets[c], cc.faceOffsets[c + 1]);
}
