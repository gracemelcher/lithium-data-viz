// Minimal TopoJSON reader plus spherical centroids, so the page needs no d3.
import { latLonToVec, vecToLatLon } from './geo.js';

/** Decode one object of a quantized TopoJSON topology into lon/lat rings. */
export function decode(topology, name) {
  const o = topology.objects[name];
  const { scale: [sx, sy], translate: [tx, ty] } = topology.transform;
  const arcs = topology.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map((d) => {
      x += d[0]; y += d[1];
      return [x * sx + tx, y * sy + ty];
    });
  });
  const ring = (idx) => {
    const pts = [];
    for (const i of idx) {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      pts.push(...(pts.length ? a.slice(1) : a));
    }
    return pts;
  };
  return o.geometries.map((g) => ({
    id: g.id == null ? null : String(+g.id),
    name: g.properties && g.properties.name,
    polygons: g.type === 'Polygon' ? [g.arcs.map(ring)] : g.arcs.map((p) => p.map(ring)),
  }));
}

/**
 * Area-weighted centroid of a feature, as [lon, lat]. Rings are fanned into
 * 3-D triangles, which is accurate enough at country scale; the sprawling
 * outliers are pinned by hand in data.js.
 */
export function centroid(feature) {
  let cx = 0, cy = 0, cz = 0, total = 0;
  for (const poly of feature.polygons) {
    const ring = poly[0];
    if (ring.length < 3) continue;
    const a = latLonToVec(ring[0][1], ring[0][0]);
    for (let i = 1; i < ring.length - 1; i++) {
      const b = latLonToVec(ring[i][1], ring[i][0]);
      const c = latLonToVec(ring[i + 1][1], ring[i + 1][0]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const area = Math.hypot(...n) / 2;
      if (!area) continue;
      total += area;
      cx += area * (a[0] + b[0] + c[0]) / 3;
      cy += area * (a[1] + b[1] + c[1]) / 3;
      cz += area * (a[2] + b[2] + c[2]) / 3;
    }
  }
  if (!total) return null;
  const n = Math.hypot(cx, cy, cz);
  return vecToLatLon([cx / n, cy / n, cz / n]).reverse();
}
