// Spherical helpers and the Dymaxion (gnomonic icosahedral) projection.
import { DYMAXION } from './dymaxion-data.js';

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const VERTS = DYMAXION.verts;
export const FACES = DYMAXION.faces;
/**
 * The net's rigid pieces. Fuller cuts two of the twenty faces along a median
 * and places the halves apart, so a piece is a face or a part of one, and two
 * pieces can carry the same face.
 */
export const PIECES = DYMAXION.pieces;
/** The sheet's silhouette, as [[x0,y0],[x1,y1]] segments in net space. */
export const BOUNDARY = DYMAXION.boundary;

/**
 * Every wedge of the net as a flat cell: which face it belongs to, its corners
 * in net space, and the same corners as barycentric coordinates on that face.
 * This is what maps between the sphere and the sheet in both directions.
 */
export const NET_CELLS = PIECES.flatMap((pc, i) =>
  pc.tris.map((t) => ({ piece: i, f: pc.f, p: t.p, b: t.b })));

/** Corner points of each piece, for fitting the sheet to the viewport. */
export const PIECE_PTS = PIECES.map((pc) => {
  const seen = new Set(), out = [];
  for (const t of pc.tris) {
    for (const p of t.p) {
      const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
  }
  return out;
});

export function latLonToVec(lat, lon) {
  const la = lat * D2R, lo = lon * D2R, c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

export function vecToLatLon(v) {
  return [Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D, Math.atan2(v[1], v[0]) * R2D];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };

// Outward normal and a corner of each icosahedron face.
export const FACE_NORMALS = FACES.map((f) =>
  norm(cross(sub(VERTS[f[1]], VERTS[f[0]]), sub(VERTS[f[2]], VERTS[f[0]]))));
const FACE_D = FACES.map((f, i) => dot(VERTS[f[0]], FACE_NORMALS[i]));

// Cells grouped by face, so a lookup only tries the one face's wedges.
const CELLS_BY_FACE = FACES.map(() => []);
for (const c of NET_CELLS) CELLS_BY_FACE[c.f].push(c);

/**
 * Solve for the barycentric weights of `b` (a barycentric point on the face)
 * within a cell whose corners are the cell's three barycentric triples. Both
 * live on the same plane, so two components determine it.
 */
function weightsInCell(cell, b) {
  const [B0, B1, B2] = cell.b;
  const a11 = B0[0] - B2[0], a12 = B1[0] - B2[0];
  const a21 = B0[1] - B2[1], a22 = B1[1] - B2[1];
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-12) return null;
  const r0 = b[0] - B2[0], r1 = b[1] - B2[1];
  const w0 = (r0 * a22 - a12 * r1) / det;
  const w1 = (a11 * r1 - r0 * a21) / det;
  return [w0, w1, 1 - w0 - w1];
}

/** Which icosahedron face does this direction fall on? */
export function faceOf(v) {
  let best = 0, bd = -Infinity;
  for (let i = 0; i < 20; i++) {
    const d = dot(v, FACE_NORMALS[i]);
    if (d > bd) { bd = d; best = i; }
  }
  return best;
}

/** Barycentric coordinates of the gnomonic projection of `v` onto face `f`. */
export function baryOnFace(v, f) {
  const n = FACE_NORMALS[f];
  const k = FACE_D[f] / dot(v, n);
  const q = [v[0] * k, v[1] * k, v[2] * k];
  const [ia, ib, ic] = FACES[f];
  const A = VERTS[ia];
  const v0 = sub(VERTS[ib], A), v1 = sub(VERTS[ic], A), v2 = sub(q, A);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1);
  const d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  const b1 = (d11 * d20 - d01 * d21) / den;
  const b2 = (d00 * d21 - d01 * d20) / den;
  return [1 - b1 - b2, b1, b2];
}

/** Unit direction -> flat map coordinates. Returns [x, y, faceIndex]. */
export function sphereToNet(v) {
  const f = faceOf(v);
  const b = baryOnFace(v, f);
  const cells = CELLS_BY_FACE[f];
  let best = null, bestSlack = -Infinity;
  for (const cell of cells) {
    const w = weightsInCell(cell, b);
    if (!w) continue;
    const slack = Math.min(w[0], w[1], w[2]);
    if (slack > bestSlack) { bestSlack = slack; best = { cell, w }; }
    if (slack >= -1e-9) break;              // inside this wedge, done
  }
  if (!best) return [0, 0, f];
  const { cell, w } = best;
  return [
    w[0] * cell.p[0][0] + w[1] * cell.p[1][0] + w[2] * cell.p[2][0],
    w[0] * cell.p[0][1] + w[1] * cell.p[1][1] + w[2] * cell.p[2][1],
    f,
  ];
}

export function lonLatToNet(lon, lat) {
  return sphereToNet(latLonToVec(lat, lon));
}

export const NET_BOUNDS = (() => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of PIECE_PTS) for (const p of pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
})();

/**
 * Great-circle samples between two directions, projected to the flat map and
 * split wherever the path jumps across one of the net's cut edges.
 */
export function netArc(a, b, steps = 48, jump = 0.45) {
  const om = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  const runs = [];
  let run = [];
  let prev = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let p;
    if (om < 1e-6) p = a;
    else {
      const s0 = Math.sin((1 - t) * om) / Math.sin(om), s1 = Math.sin(t * om) / Math.sin(om);
      p = norm([a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1]);
    }
    const q = sphereToNet(p);
    if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) > jump) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    run.push([q[0], q[1], t]);
    prev = q;
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
