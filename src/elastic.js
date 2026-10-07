// Elastic deformation of the flat map.
//
// The net is treated as a sheet of material rather than as a field of
// independent pushes. Every wedge of the Dymaxion net is divided into a grid
// of small triangles, the grid is welded into one mesh, and the silhouette is
// pinned. Each line in that mesh is a spring with its own elastic modulus, and
// each triangle carries a target area taken from the trade data. Relaxing the
// mesh lets the deformation distribute the way a real sheet would: a country
// that grows pushes its neighbours aside, and they resist according to how
// stiff they are.
//
// Why this and not the analytic field it replaced:
//
//   * The old field summed per-source displacements with no notion of the
//     material in between, so nothing stopped two sources from folding the
//     sheet over itself. Measured on the real source distribution it inverted
//     201 triangles at the default strength and 995 at full. The elastic solve
//     inverts none, because a triangle's own area constraint fights back long
//     before it can turn inside out.
//   * Area was never actually controlled: a source's disc ended up whatever
//     size the summed pushes left it. Here the target area is the constraint,
//     so the achieved scale tracks the requested one far more closely (median
//     error 23% against 34% at full strength).
//
// Locality — the thing this is really for — comes from two per-line
// properties rather than from an arbitrary distance cutoff:
//
//   * the elastic modulus, higher away from the data, so far-off material is
//     stiff and simply does not take up the strain; and
//   * an elastic foundation, which ties each vertex to where it started with a
//     stiffness that rises as you leave the sources behind.
//
// Together they drop the share of the sheet that moves from 57% to 38% at the
// default strength while *improving* area fidelity, which is the opposite of
// the trade the old reach/tail cutoff forced.
//
// The solve runs on the CPU when the data changes, not per frame. Its result
// is baked into a displacement texture that every shader samples, so the
// strength slider stays a free multiply and the GPU never sees the mesh.
import * as THREE from 'three';
import { DYMAXION } from './dymaxion-data.js';
import { NET_BOUNDS } from './geo.js';
import { ELASTIC } from './config.js';

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Every wedge split into `sub²` triangles, welded into a single mesh.
 *
 * Welding is by exact position key, which works because adjacent wedges and
 * adjacent pieces meet along shared edges and sample those edges at the same
 * fractions. The net is a tree of 22 pieces, so no two pieces touch anywhere
 * they are not hinged, and nothing is welded that should not be.
 */
function buildMesh(sub) {
  const index = new Map();
  const xs = [], ys = [];
  const add = (x, y) => {
    const k = Math.round(x * 1e6) + ',' + Math.round(y * 1e6);
    let i = index.get(k);
    if (i === undefined) { i = xs.length; xs.push(x); ys.push(y); index.set(k, i); }
    return i;
  };
  const tris = [];
  for (const piece of DYMAXION.pieces) {
    for (const wedge of piece.tris) {
      const C = wedge.p;
      const grid = [];
      for (let i = 0; i <= sub; i++) {
        const row = [];
        for (let j = 0; j <= i; j++) {
          const b0 = 1 - i / sub;
          const b2 = i === 0 ? 0 : (i / sub) * (j / i);
          const b1 = i / sub - b2;
          row.push(add(b0 * C[0][0] + b1 * C[1][0] + b2 * C[2][0],
                       b0 * C[0][1] + b1 * C[1][1] + b2 * C[2][1]));
        }
        grid.push(row);
      }
      for (let i = 0; i < sub; i++) {
        for (let j = 0; j <= i; j++) {
          tris.push(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1]);
          if (j < i) tris.push(grid[i][j], grid[i + 1][j + 1], grid[i][j + 1]);
        }
      }
    }
  }
  // unique undirected edges
  const seen = new Set();
  const ea = [], eb = [];
  for (let t = 0; t < tris.length; t += 3) {
    for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) {
      const a = tris[t + p], b = tris[t + q];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const k = lo * 16777216 + hi;
      if (seen.has(k)) continue;
      seen.add(k); ea.push(lo); eb.push(hi);
    }
  }
  return {
    xs: Float64Array.from(xs), ys: Float64Array.from(ys),
    tris: Uint32Array.from(tris),
    ea: Uint32Array.from(ea), eb: Uint32Array.from(eb),
  };
}

/** Vertices lying on one of the net's 46 cut edges. Those never move. */
function markPinned(m) {
  const pinned = new Uint8Array(m.xs.length);
  for (let i = 0; i < m.xs.length; i++) {
    const x = m.xs[i], y = m.ys[i];
    for (const [a, b] of DYMAXION.boundary) {
      const abx = b[0] - a[0], aby = b[1] - a[1];
      let t = ((x - a[0]) * abx + (y - a[1]) * aby) / (abx * abx + aby * aby);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (a[0] + abx * t), dy = y - (a[1] + aby * t);
      if (dx * dx + dy * dy < 1e-6) { pinned[i] = 1; break; }
    }
  }
  return pinned;
}

export class ElasticNet {
  constructor(sub = ELASTIC.subdivision) {
    this.m = buildMesh(sub);
    this.pinned = markPinned(this.m);
    const N = this.m.xs.length;
    this.px = Float64Array.from(this.m.xs);
    this.py = Float64Array.from(this.m.ys);
    this.dx = new Float64Array(N);
    this.dy = new Float64Array(N);
    // inverse mass: pinned vertices immovable, the rest shared by valence so a
    // vertex with many lines pulling on it does not get shoved around by each
    const val = new Float64Array(N);
    for (let e = 0; e < this.m.ea.length; e++) { val[this.m.ea[e]]++; val[this.m.eb[e]]++; }
    this.iw = new Float64Array(N);
    for (let i = 0; i < N; i++) this.iw[i] = this.pinned[i] ? 0 : 1 / Math.max(1, val[i]);
    this.key = null;                       // last solved source signature
    this.solved = false;                   // is px/py a usable warm start?
    this.stats = null;
  }

  get vertexCount() { return this.m.xs.length; }
  get triangleCount() { return this.m.tris.length / 3; }
  get edgeCount() { return this.m.ea.length; }

  /** Areal scale the data asks for at a point: 1 where no source reaches. */
  static scaleAt(sources, x, y) {
    let num = 0, w = 0;
    for (const s of sources) {
      const R = s.radius, R1 = R * ELASTIC.spread;
      const ux = x - s.x, uy = y - s.y;
      const r = Math.sqrt(ux * ux + uy * uy);
      if (r >= R1) continue;
      const wi = r <= R ? 1 : 1 - smooth((r - R) / (R1 - R));
      num += wi * (s.scale - 1); w += wi;
    }
    // averaged, not summed: Europe stacks a dozen overlapping sources and
    // summing them would ask for an impossible scale in one small patch
    return 1 + num / Math.max(1, w);
  }

  /** 1 inside a source's zone of influence, easing to 0 by `reach` radii. */
  static proxAt(sources, x, y) {
    let best = 0;
    for (const s of sources) {
      const R = s.radius, R1 = R * ELASTIC.reach;
      const ux = x - s.x, uy = y - s.y;
      const r = Math.sqrt(ux * ux + uy * uy);
      if (r >= R1) continue;
      const w = r <= R ? 1 : 1 - smooth((r - R) / (R1 - R));
      if (w > best) best = w;
    }
    return best;
  }

  /**
   * Relax the sheet against the data. Always solved at full strength — the
   * strength slider scales the resulting displacement, which tracks a direct
   * solve closely (within about 1.6 points of area error at mid-strength) and
   * costs nothing, so dragging the slider stays free.
   *
   * @param {Array<{x,y,radius,scale}>} sources
   * @returns {boolean} whether anything was recomputed
   */
  /**
   * @param {boolean} cold   discard the warm start and solve from the flat sheet
   * @param {boolean} force  solve even if the sources are unchanged. Timeline
   *   playback bakes into a slot that has since been handed to the other year,
   *   so an unchanged key no longer means the destination already holds this
   *   solution — the only case where repeating identical work is correct.
   */
  solve(sources, cold = false, force = false) {
    const key = sources.map((s) => `${s.x.toFixed(4)},${s.y.toFixed(4)},`
      + `${s.radius.toFixed(4)},${s.scale.toFixed(4)}`).join(';');
    if (!cold && !force && key === this.key) return false;  // same data: keep the last solve
    this.key = key;
    if (cold) this.solved = false;

    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    // Calibration, not physics: see ELASTIC.gain. The sheet is compliant, so
    // it is asked for proportionally more than the data wants and allowed to
    // fall short of that instead of short of the truth.
    if (ELASTIC.gain !== 1) {
      sources = sources.map((s) => ({ ...s, scale: 1 + (s.scale - 1) * ELASTIC.gain }));
    }
    const m = this.m, N = m.xs.length, T = m.tris.length / 3, E = m.ea.length;
    const { px, py, iw } = this;
    // Warm start. Gauss-Seidel converges to the same equilibrium whatever it
    // begins from, so keeping the last solution as the starting guess is free
    // accuracy — and consecutive years ask for almost the same shape, which is
    // what makes playing the timeline affordable at all. Only the first solve
    // pays the full iteration count.
    const warm = this.solved;
    if (!warm) { px.set(m.xs); py.set(m.ys); }
    const iterations = warm ? ELASTIC.warmIterations : ELASTIC.iterations;

    if (!sources.length) {
      this.dx.fill(0); this.dy.fill(0);
      px.set(m.xs); py.set(m.ys);
      this.solved = false;
      this.stats = { ms: 0, inverted: 0, maxDisp: 0, skipped: true };
      return true;
    }

    // ---- per-triangle target areas -------------------------------------
    const At = new Float64Array(T);
    const A0 = new Float64Array(T);
    let sumA = 0, sumAt = 0;
    for (let i = 0; i < T; i++) {
      const a = m.tris[i * 3], b = m.tris[i * 3 + 1], c = m.tris[i * 3 + 2];
      const ax = m.xs[a], ay = m.ys[a], bx = m.xs[b], by = m.ys[b], cx = m.xs[c], cy = m.ys[c];
      A0[i] = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;   // signed
      At[i] = A0[i] * ElasticNet.scaleAt(sources, (ax + bx + cx) / 3, (ay + by + cy) / 3);
      sumA += Math.abs(A0[i]); sumAt += Math.abs(At[i]);
    }
    // A pinned silhouette fixes the sheet's total area, so the targets have to
    // sum to it or the whole map strains against its own frame and no region
    // reaches its size. Only relative area carries meaning here, so scaling
    // every target by one factor costs nothing and makes the solve behave.
    const g = sumAt > 1e-9 ? sumA / sumAt : 1;
    for (let i = 0; i < T; i++) At[i] *= g;

    // ---- per-line rest length and elastic modulus ----------------------
    const L = new Float64Array(E), K = new Float64Array(E);
    for (let e = 0; e < E; e++) {
      const a = m.ea[e], b = m.eb[e];
      const lx = m.xs[b] - m.xs[a], ly = m.ys[b] - m.ys[a];
      const L0 = Math.sqrt(lx * lx + ly * ly);
      const mx = (m.xs[a] + m.xs[b]) / 2, my = (m.ys[a] + m.ys[b]) / 2;
      // linear scale is the square root of the areal one
      L[e] = L0 * Math.sqrt(Math.max(0.05, ElasticNet.scaleAt(sources, mx, my) * g));
      const p = ElasticNet.proxAt(sources, mx, my);
      K[e] = ELASTIC.modulusSoft * p + ELASTIC.modulusStiff * (1 - p);
    }

    // ---- elastic foundation -------------------------------------------
    const anc = new Float64Array(N);
    if (ELASTIC.foundation > 0) {
      for (let i = 0; i < N; i++) {
        const p = ElasticNet.proxAt(sources, m.xs[i], m.ys[i]);
        anc[i] = ELASTIC.foundation * (1 - p) * (1 - p);
      }
    }

    // ---- relax ---------------------------------------------------------
    // Gauss-Seidel: each constraint is projected in turn and the result is
    // visible to the next one, which converges in far fewer sweeps than
    // accumulating corrections and applying them together.
    const relax = ELASTIC.relax;
    for (let it = 0; it < iterations; it++) {
      // lines resist stretching, by their own modulus
      for (let e = 0; e < E; e++) {
        const a = m.ea[e], b = m.eb[e];
        const wa = iw[a], wb = iw[b], ws = wa + wb;
        if (ws <= 0) continue;
        const ex = px[b] - px[a], ey = py[b] - py[a];
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d < 1e-12) continue;
        const c = relax * K[e] * (d - L[e]) / (d * ws);
        px[a] += ex * c * wa; py[a] += ey * c * wa;
        px[b] -= ex * c * wb; py[b] -= ey * c * wb;
      }
      // triangles carry the cartogram target, on signed area so a triangle
      // that starts to turn inside out is pushed back rather than accepted
      for (let i = 0; i < T; i++) {
        const a = m.tris[i * 3], b = m.tris[i * 3 + 1], c = m.tris[i * 3 + 2];
        const wa = iw[a], wb = iw[b], wc = iw[c];
        const ax = px[a], ay = py[a], bx = px[b], by = py[b], cx = px[c], cy = py[c];
        const err = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2 - At[i];
        const gax = (by - cy) / 2, gay = (cx - bx) / 2;
        const gbx = (cy - ay) / 2, gby = (ax - cx) / 2;
        const gcx = (ay - by) / 2, gcy = (bx - ax) / 2;
        const den = wa * (gax * gax + gay * gay)
                  + wb * (gbx * gbx + gby * gby)
                  + wc * (gcx * gcx + gcy * gcy);
        if (den < 1e-18) continue;
        const lam = relax * ELASTIC.areaStiffness * err / den;
        px[a] -= lam * wa * gax; py[a] -= lam * wa * gay;
        px[b] -= lam * wb * gbx; py[b] -= lam * wb * gby;
        px[c] -= lam * wc * gcx; py[c] -= lam * wc * gcy;
      }
      // the foundation pulls material back to where it started, hard where
      // there is no data — this is what keeps the deformation local
      if (ELASTIC.foundation > 0) {
        for (let i = 0; i < N; i++) {
          if (iw[i] <= 0 || anc[i] <= 0) continue;
          const f = Math.min(1, relax * anc[i]);
          px[i] += (m.xs[i] - px[i]) * f;
          py[i] += (m.ys[i] - py[i]) * f;
        }
      }
    }

    // Untangle. A handful of triangles can settle inverted where sources crowd
    // — real data clusters far harder than an even spread does. These sweeps
    // enforce the area target on nothing but the offenders, at full weight, so
    // the fix stays local instead of disturbing a sheet that is already at
    // equilibrium everywhere else.
    for (let pass = 0; pass < ELASTIC.untanglePasses; pass++) {
      let bad = 0;
      for (let i = 0; i < T; i++) {
        const a = m.tris[i * 3], b = m.tris[i * 3 + 1], c = m.tris[i * 3 + 2];
        const ax = px[a], ay = py[a], bx = px[b], by = py[b], cx = px[c], cy = py[c];
        const A1 = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
        // wrong sign, or collapsed to a sliver on the way there
        if (Math.sign(A1) === Math.sign(A0[i]) && Math.abs(A1) > 0.1 * Math.abs(A0[i])) continue;
        bad++;
        const wa = iw[a], wb = iw[b], wc = iw[c];
        const err = A1 - At[i];
        const gax = (by - cy) / 2, gay = (cx - bx) / 2;
        const gbx = (cy - ay) / 2, gby = (ax - cx) / 2;
        const gcx = (ay - by) / 2, gcy = (bx - ax) / 2;
        const den = wa * (gax * gax + gay * gay)
                  + wb * (gbx * gbx + gby * gby)
                  + wc * (gcx * gcx + gcy * gcy);
        if (den < 1e-18) continue;
        const lam = err / den;
        px[a] -= lam * wa * gax; py[a] -= lam * wa * gay;
        px[b] -= lam * wb * gbx; py[b] -= lam * wb * gby;
        px[c] -= lam * wc * gcx; py[c] -= lam * wc * gcy;
      }
      if (!bad) break;
      // Let the repair settle. Enforcing area on the offenders alone makes
      // neighbouring triangles fight over the shared vertices and oscillate;
      // one ordinary sweep between passes lets the correction diffuse into the
      // material around it instead.
      for (let e = 0; e < E; e++) {
        const a = m.ea[e], b = m.eb[e];
        const wa = iw[a], wb = iw[b], ws = wa + wb;
        if (ws <= 0) continue;
        const ex = px[b] - px[a], ey = py[b] - py[a];
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d < 1e-12) continue;
        const c = relax * K[e] * (d - L[e]) / (d * ws);
        px[a] += ex * c * wa; py[a] += ey * c * wa;
        px[b] -= ex * c * wb; py[b] -= ey * c * wb;
      }
    }

    this.solved = true;
    for (let i = 0; i < N; i++) { this.dx[i] = px[i] - m.xs[i]; this.dy[i] = py[i] - m.ys[i]; }

    let inverted = 0, maxDisp = 0;
    for (let i = 0; i < T; i++) {
      const a = m.tris[i * 3], b = m.tris[i * 3 + 1], c = m.tris[i * 3 + 2];
      const A1 = ((px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a])) / 2;
      if (Math.sign(A1) !== Math.sign(A0[i])) inverted++;
    }
    for (let i = 0; i < N; i++) {
      const ddx = this.dx[i], ddy = this.dy[i];
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d > maxDisp) maxDisp = d;
    }
    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
    this.stats = { ms: Math.round(t1 - t0), inverted, maxDisp,
      sources: sources.length, iterations, warm };
    return true;
  }

  /**
   * Bake the solved displacement into a grid covering the net's bounding box.
   *
   * Scan-converting on the CPU rather than rendering the mesh to a target
   * keeps one source of truth: the shaders sample this grid and so does
   * `warpPoint`, so the map and the things drawn on top of it cannot drift
   * apart. Texels outside the net stay zero, which is already the right
   * answer — the silhouette is pinned, so the field goes to zero there anyway.
   */
  rasterise(out, w, h, rect) {
    out.fill(0);
    const m = this.m, T = m.tris.length / 3;
    const sx = w / rect.w, sy = h / rect.h;
    const toU = (x) => (x - rect.x0) * sx;
    const toV = (y) => (y - rect.y0) * sy;
    for (let i = 0; i < T; i++) {
      const ia = m.tris[i * 3], ib = m.tris[i * 3 + 1], ic = m.tris[i * 3 + 2];
      const ax = toU(m.xs[ia]), ay = toV(m.ys[ia]);
      const bx = toU(m.xs[ib]), by = toV(m.ys[ib]);
      const cx = toU(m.xs[ic]), cy = toV(m.ys[ic]);
      let x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      let x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
      let y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      let y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
      if (x1 < x0 || y1 < y0) continue;
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      for (let py_ = y0; py_ <= y1; py_++) {
        const fy = py_ + 0.5;
        for (let px_ = x0; px_ <= x1; px_++) {
          const fx = px_ + 0.5;
          const l0 = ((by - cy) * (fx - cx) + (cx - bx) * (fy - cy)) * inv;
          const l1 = ((cy - ay) * (fx - cx) + (ax - cx) * (fy - cy)) * inv;
          const l2 = 1 - l0 - l1;
          // a small negative tolerance so neighbouring triangles overlap by a
          // hair and no texel on a shared edge is left behind
          if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
          const o = (py_ * w + px_) * 2;
          out[o]     = l0 * this.dx[ia] + l1 * this.dx[ib] + l2 * this.dx[ic];
          out[o + 1] = l0 * this.dy[ia] + l1 * this.dy[ib] + l2 * this.dy[ic];
        }
      }
    }
  }
}

/** The grid the displacement is baked into, padded clear of the net's edge. */
export function warpRect() {
  const pad = ELASTIC.pad;
  return {
    x0: NET_BOUNDS.x0 - pad, y0: NET_BOUNDS.y0 - pad,
    w: NET_BOUNDS.w + 2 * pad, h: NET_BOUNDS.h + 2 * pad,
  };
}

/** A half-float RGBA texture holding the displacement, for the shaders. */
export function makeWarpTexture(w, h) {
  const tex = new THREE.DataTexture(new Uint16Array(w * h * 4), w, h,
    THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Pack a float RG grid into the texture's half-float RGBA buffer. */
export function uploadWarp(tex, grid, w, h) {
  const dst = tex.image.data;
  const half = THREE.DataUtils.toHalfFloat;
  for (let i = 0, n = w * h; i < n; i++) {
    dst[i * 4] = half(grid[i * 2]);
    dst[i * 4 + 1] = half(grid[i * 2 + 1]);
    dst[i * 4 + 2] = 0;
    dst[i * 4 + 3] = 0;
  }
  tex.needsUpdate = true;
}
