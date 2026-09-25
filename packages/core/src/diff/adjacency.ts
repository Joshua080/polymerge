/**
 * Vertex adjacency in CSR (compressed sparse row) form: the neighbours of vertex v are
 * `neighbors[offsets[v] .. offsets[v + 1])`, sorted ascending and de-duplicated.
 */
export interface IAdjacency {
  offsets: Uint32Array;
  neighbors: Uint32Array;
}

export function buildAdjacency(vertexCount: number, faces: Uint32Array): IAdjacency {
  const deg = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < faces.length; i++) deg[faces[i]] += 2;
  const start = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) start[v + 1] = start[v] + deg[v];
  const tmp = new Uint32Array(start[vertexCount]);
  const fill = start.slice(0, vertexCount);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f];
    const b = faces[f + 1];
    const c = faces[f + 2];
    tmp[fill[a]++] = b;
    tmp[fill[a]++] = c;
    tmp[fill[b]++] = a;
    tmp[fill[b]++] = c;
    tmp[fill[c]++] = a;
    tmp[fill[c]++] = b;
  }
  // Sort + dedupe each segment, compacting in place.
  const offsets = new Uint32Array(vertexCount + 1);
  let w = 0;
  for (let v = 0; v < vertexCount; v++) {
    const s = start[v];
    const e = start[v + 1];
    offsets[v] = w;
    if (e - s <= 24) {
      for (let i = s + 1; i < e; i++) {
        const x = tmp[i];
        let j = i - 1;
        while (j >= s && tmp[j] > x) {
          tmp[j + 1] = tmp[j];
          j--;
        }
        tmp[j + 1] = x;
      }
    } else {
      tmp.subarray(s, e).sort();
    }
    let prev = -1;
    for (let i = s; i < e; i++) {
      const x = tmp[i];
      if (x !== prev && x !== v) tmp[w++] = x;
      prev = x;
    }
  }
  offsets[vertexCount] = w;
  return { offsets, neighbors: tmp.slice(0, w) };
}

/**
 * Incident faces per vertex in CSR form (same `IAdjacency` shape: `neighbors` holds face
 * indices, ascending).
 */
export function buildVertexFaces(vertexCount: number, faces: Uint32Array): IAdjacency {
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < faces.length; i++) offsets[faces[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(0, vertexCount);
  const list = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i++) list[fill[faces[i]]++] = (i / 3) | 0;
  return { offsets, neighbors: list };
}

/** True if u is a neighbour of v. Linear scan for short lists, binary search otherwise. */
export function hasNeighbor(adj: IAdjacency, v: number, u: number): boolean {
  const nb = adj.neighbors;
  let lo = adj.offsets[v];
  let hi = adj.offsets[v + 1];
  if (hi - lo <= 16) {
    for (let i = lo; i < hi; i++) if (nb[i] === u) return true;
    return false;
  }
  hi--;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const x = nb[mid];
    if (x === u) return true;
    if (x < u) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Mean length of the edges incident to each vertex. Vertices without edges get the
 * global mean edge length (or 1 if the mesh has no edges at all).
 */
export function meanEdgeLengths(positions: Float64Array, adj: IAdjacency): Float64Array {
  const n = adj.offsets.length - 1;
  const out = new Float64Array(n);
  let total = 0;
  let count = 0;
  const off = adj.offsets;
  const nb = adj.neighbors;
  for (let v = 0; v < n; v++) {
    const s = off[v];
    const e = off[v + 1];
    if (e === s) continue;
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let sum = 0;
    for (let i = s; i < e; i++) {
      const u = nb[i] * 3;
      sum += Math.hypot(positions[u] - x, positions[u + 1] - y, positions[u + 2] - z);
    }
    out[v] = sum / (e - s);
    total += sum;
    count += e - s;
  }
  const global = count > 0 && total > 0 ? total / count : 1;
  for (let v = 0; v < n; v++) if (!(out[v] > 0)) out[v] = global;
  return out;
}
