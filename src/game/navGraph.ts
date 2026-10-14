import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { WORLD_ONLY_QUERY } from "./types";

export interface NavBounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

const NAV_MAGIC = 0x564e4250; // "PBNV"
const NAV_VERSION = 2;
const boundsArray = (b: NavBounds): number[] => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];

/** FNV-1a over the respawn feet: a bake made for other respawns keeps other components */
function seedHash(seeds: THREE.Vector3[]): number {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  for (const s of seeds) for (const c of [s.x, s.y, s.z]) {
    f[0] = c;
    for (const w of u) { h ^= w; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h >>> 0;
}

/**
 * Grid navigation graph built at load time (or baked offline: `toBuffer` / `load`) by raycasting the collision trimesh:
 * down-rays find walkable floors (multi-layer), links require a clear waist-high ray and a
 * floor under the midpoint. Only the component reachable from the respawns is kept, which
 * drops roofs / out-of-bounds islands.
 */
export class NavGraph {
  readonly px: number[] = [];
  readonly py: number[] = [];
  readonly pz: number[] = [];
  readonly adj: number[][] = [];
  private cells = new Map<number, number[]>();

  private constructor(private spacing: number, private minX: number, private minZ: number) {}

  get size(): number {
    return this.px.length;
  }

  pos(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.px[i], this.py[i], this.pz[i]);
  }

  private key(ix: number, iz: number): number {
    return ix * 8192 + iz;
  }

  static build(
    world: RAPIER.World,
    R: typeof RAPIER,
    bounds: { min: THREE.Vector3; max: THREE.Vector3 },
    seeds: THREE.Vector3[],
    spacing = 1.75
  ): NavGraph {
    const t0 = performance.now();
    const raw = new NavGraph(spacing, bounds.min.x, bounds.min.z);
    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const cast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number) => {
      ray.origin = { x: ox, y: oy, z: oz };
      ray.dir = { x: dx, y: dy, z: dz };
      return world.castRayAndGetNormal(ray, len, true, undefined, WORLD_ONLY_QUERY);
    };
    const floorBelow = (x: number, y: number, z: number, len: number): number | null => {
      const h = cast(x, y, z, 0, -1, 0, len);
      if (!h || h.normal.y < 0.6) return null;
      return y - h.timeOfImpact;
    };

    const nx = Math.ceil((bounds.max.x - bounds.min.x) / spacing) + 1;
    const nz = Math.ceil((bounds.max.z - bounds.min.z) / spacing) + 1;
    const top = bounds.max.y + 1;
    const bottom = bounds.min.y - 1;
    const nodeCell: number[] = [];
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = bounds.min.x + ix * spacing;
        const z = bounds.min.z + iz * spacing;
        let y = top;
        for (let layer = 0; layer < 8 && y > bottom; layer++) {
          const h = cast(x, y, z, 0, -1, 0, y - bottom);
          if (!h) break;
          const fy = y - h.timeOfImpact;
          if (h.normal.y > 0.7 && !cast(x, fy + 0.05, z, 0, 1, 0, 1.75)) {
            const id = raw.px.length;
            raw.px.push(x);
            raw.py.push(fy);
            raw.pz.push(z);
            raw.adj.push([]);
            const k = raw.key(ix, iz);
            let list = raw.cells.get(k);
            if (!list) raw.cells.set(k, (list = []));
            list.push(id);
            nodeCell.push(k);
          }
          y = fy - 0.05;
        }
      }
    }

    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let i = 0; i < raw.px.length; i++) {
      const k = nodeCell[i];
      const ix = Math.floor(k / 8192);
      const iz = k - ix * 8192;
      for (const [dx, dz] of dirs) {
        const list = raw.cells.get(raw.key(ix + dx, iz + dz));
        if (!list) continue;
        const horiz = spacing * Math.hypot(dx, dz);
        for (const j of list) {
          const dy = raw.py[j] - raw.py[i];
          if (Math.abs(dy) > horiz * 0.85 + 0.1) continue;
          const ax = raw.px[i], ay = raw.py[i] + 1.0, az = raw.pz[i];
          const bx = raw.px[j], by = raw.py[j] + 1.0, bz = raw.pz[j];
          const len = Math.hypot(bx - ax, by - ay, bz - az);
          if (cast(ax, ay, az, (bx - ax) / len, (by - ay) / len, (bz - az) / len, len)) continue;
          if (Math.abs(dy) < 0.25) {
            const ly = Math.max(raw.py[i], raw.py[j]) + 0.45;
            const ll = Math.hypot(bx - ax, bz - az);
            if (cast(ax, ly, az, (bx - ax) / ll, 0, (bz - az) / ll, ll)) continue;
          }
          const lo = Math.min(raw.py[i], raw.py[j]);
          const hi = Math.max(raw.py[i], raw.py[j]);
          const mf = floorBelow((ax + bx) / 2, hi + 0.9, (az + bz) / 2, hi - lo + 1.4);
          if (mf === null || mf < lo - 0.4 || mf > hi + 0.4) continue;
          raw.adj[i].push(j);
          raw.adj[j].push(i);
        }
      }
    }

    // Keep the component(s) reachable from the respawns.
    const keep = new Uint8Array(raw.px.length);
    const queue: number[] = [];
    for (const s of seeds) {
      const n = raw.nearest(s, 4);
      if (n >= 0 && !keep[n]) {
        keep[n] = 1;
        queue.push(n);
      }
    }
    while (queue.length) {
      const n = queue.pop()!;
      for (const m of raw.adj[n]) if (!keep[m]) { keep[m] = 1; queue.push(m); }
    }
    const g = new NavGraph(spacing, bounds.min.x, bounds.min.z);
    const remap = new Int32Array(raw.px.length).fill(-1);
    for (let i = 0; i < raw.px.length; i++) {
      if (!keep[i]) continue;
      remap[i] = g.px.length;
      g.px.push(raw.px[i]);
      g.py.push(raw.py[i]);
      g.pz.push(raw.pz[i]);
      g.adj.push([]);
      const k = nodeCell[i];
      let list = g.cells.get(k);
      if (!list) g.cells.set(k, (list = []));
      list.push(remap[i]);
    }
    for (let i = 0; i < raw.px.length; i++) {
      if (remap[i] < 0) continue;
      g.adj[remap[i]] = raw.adj[i].map((j) => remap[j]).filter((j) => j >= 0);
    }
    console.info(`[nav] ${g.size} nodes (of ${raw.px.length} probed) in ${(performance.now() - t0).toFixed(0)} ms`);
    return g;
  }

  /**
   * Baked graph file (pb-extract-tools bake-navgraph.mjs -> public/assets/maps/<map>/navgraph.bin), little endian: 80-byte header
   * (magic, version, nodes, forward edges, seed hash, spacing f64, bounds min/max xyz f64), then ix u16[n], iz u16[n],
   * py f64[n], forward-edge offsets u32[n+1], forward neighbours u32[edges]. px / pz are `min + i * spacing`, as `build` computes them,
   * so a loaded graph is identical to the built one (same nodes, same adjacency order: A* breaks ties the same way).
   * Only the edges to a higher node id are stored: build links each node to cells after its own, so adj[i] is its lower
   * neighbours (pushed while those were processed, ascending) then its higher ones; `fromBuffer` replays that.
   */
  toBuffer(bounds: NavBounds, seeds: THREE.Vector3[]): ArrayBuffer {
    const n = this.size;
    let edges = 0;
    for (let i = 0; i < n; i++) {
      let seenHigher = false;
      for (const j of this.adj[i]) {
        if (j > i) { edges++; seenHigher = true; } else if (seenHigher || j === i) throw new Error('nav adjacency order: cannot bake');
      }
    }
    const pyOff = (80 + 4 * n + 7) & ~7;
    const offOff = pyOff + 8 * n;
    const nbOff = offOff + 4 * (n + 1);
    const buf = new ArrayBuffer(nbOff + 4 * edges);
    const dv = new DataView(buf);
    dv.setUint32(0, NAV_MAGIC, true);
    dv.setUint32(4, NAV_VERSION, true);
    dv.setUint32(8, n, true);
    dv.setUint32(12, edges, true);
    dv.setUint32(16, seedHash(seeds), true);
    dv.setFloat64(24, this.spacing, true);
    boundsArray(bounds).forEach((v, i) => dv.setFloat64(32 + i * 8, v, true));
    const ix = new Uint16Array(buf, 80, n), iz = new Uint16Array(buf, 80 + 2 * n, n);
    const py = new Float64Array(buf, pyOff, n), off = new Uint32Array(buf, offOff, n + 1), nb = new Uint32Array(buf, nbOff, edges);
    let e = 0;
    for (let i = 0; i < n; i++) {
      ix[i] = Math.round((this.px[i] - this.minX) / this.spacing);
      iz[i] = Math.round((this.pz[i] - this.minZ) / this.spacing);
      py[i] = this.py[i];
      off[i] = e;
      for (const j of this.adj[i]) if (j > i) nb[e++] = j;
    }
    off[n] = e;
    return buf;
  }

  /** The baked graph, or null when the file is not one or was baked for other bounds / spacing / respawns (the caller then builds it). */
  static fromBuffer(buf: ArrayBuffer, bounds: NavBounds, seeds: THREE.Vector3[], spacing = 1.75): NavGraph | null {
    if (buf.byteLength < 80) return null;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== NAV_MAGIC || dv.getUint32(4, true) !== NAV_VERSION) return null;
    const n = dv.getUint32(8, true), edges = dv.getUint32(12, true);
    if (dv.getUint32(16, true) !== seedHash(seeds) || dv.getFloat64(24, true) !== spacing) return null;
    if (!boundsArray(bounds).every((v, i) => dv.getFloat64(32 + i * 8, true) === v)) return null;
    const pyOff = (80 + 4 * n + 7) & ~7;
    const offOff = pyOff + 8 * n;
    const nbOff = offOff + 4 * (n + 1);
    if (buf.byteLength !== nbOff + 4 * edges) return null;
    const ix = new Uint16Array(buf, 80, n), iz = new Uint16Array(buf, 80 + 2 * n, n);
    const py = new Float64Array(buf, pyOff, n), off = new Uint32Array(buf, offOff, n + 1), nb = new Uint32Array(buf, nbOff, edges);
    const g = new NavGraph(spacing, bounds.min.x, bounds.min.z);
    for (let i = 0; i < n; i++) {
      g.px.push(bounds.min.x + ix[i] * spacing);
      g.py.push(py[i]);
      g.pz.push(bounds.min.z + iz[i] * spacing);
      g.adj.push([]);
      const k = g.key(ix[i], iz[i]);
      const list = g.cells.get(k);
      if (list) list.push(i);
      else g.cells.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      for (let e = off[i]; e < off[i + 1]; e++) {
        g.adj[i].push(nb[e]);
        g.adj[nb[e]].push(i);
      }
    }
    return g;
  }

  /** Baked graph at `url`, or built live when there is none (404, vite's index.html fallback, stale bake). */
  static async load(url: string, world: RAPIER.World, R: typeof RAPIER, bounds: NavBounds, seeds: THREE.Vector3[]): Promise<NavGraph> {
    try {
      const r = await fetch(url);
      if (r.ok && !(r.headers.get("content-type") ?? "").includes("text/html")) {
        const t0 = performance.now();
        const g = NavGraph.fromBuffer(await r.arrayBuffer(), bounds, seeds);
        if (g) {
          console.info(`[nav] baked graph: ${g.size} nodes in ${(performance.now() - t0).toFixed(0)} ms`);
          return g;
        }
        console.warn("[nav] baked graph does not match this map, building");
      }
    } catch (err) {
      console.warn("[nav] baked graph unavailable, building", err);
    }
    return NavGraph.build(world, R, bounds, seeds);
  }

  /** Nearest node within `radiusCells` grid cells (vertical distance weighted 2x), or -1. */
  nearest(p: THREE.Vector3, radiusCells = 2): number {
    const cx = Math.round((p.x - this.minX) / this.spacing);
    const cz = Math.round((p.z - this.minZ) / this.spacing);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= radiusCells; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
          const list = this.cells.get(this.key(ix, iz));
          if (!list) continue;
          for (const i of list) {
            const dy = (this.py[i] - p.y) * 2;
            const d = (this.px[i] - p.x) ** 2 + dy * dy + (this.pz[i] - p.z) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      if (best >= 0 && r >= 1) break;
    }
    return best;
  }

  randomNode(): number {
    return this.size ? Math.floor(Math.random() * this.size) : -1;
  }

  /** A* from a to b; returns node indices (excluding a) or null. */
  path(a: number, b: number): number[] | null {
    if (a < 0 || b < 0) return null;
    if (a === b) return [b];
    const n = this.size;
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const h = (i: number) => Math.hypot(this.px[i] - this.px[b], this.py[i] - this.py[b], this.pz[i] - this.pz[b]);
    g[a] = 0;
    heap.push(a, h(a));
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === b) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expanded > 20000) return null;
      for (const nb of this.adj[cur]) {
        if (closed[nb]) continue;
        const cost = g[cur] + Math.hypot(this.px[nb] - this.px[cur], this.py[nb] - this.py[cur], this.pz[nb] - this.pz[cur]);
        if (cost < g[nb]) {
          g[nb] = cost;
          came[nb] = cur;
          heap.push(nb, cost + h(nb));
        }
      }
    }
    if (came[b] < 0) return null;
    const out: number[] = [];
    for (let c = b; c !== a; c = came[c]) out.push(c);
    return out.reverse();
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}
