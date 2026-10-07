// Paints the equirectangular base map that the globe and the flat net share.
// Because the mesh keeps its UVs through the whole morph, this one canvas is
// what visibly stretches when the grid is deformed later on.
import * as THREE from 'three';
import { TEXTURE_WIDTH } from './config.js';

// Set once per call from TEXTURE_WIDTH and the GPU's own ceiling. Module-level
// rather than threaded through every helper: this module paints exactly one
// canvas per run, and px()/py() and the ring tracing all need the size.
let W = 4096, H = 2048;

function unwrap(ring) {
  const out = [ring[0].slice()];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (prev - lon > 180) lon += 360;
    out.push([lon, ring[i][1]]);
  }
  return out;
}

const px = (lon, shift) => ((lon + shift + 180) / 360) * W;
const py = (lat) => ((90 - lat) / 180) * H;

/**
 * Does this ring sweep the whole globe in longitude? Only Antarctica does.
 *
 * That is the crux of drawing it. The ring is the true coastline, traced from
 * the antimeridian right around and back, but because it spans all 360 degrees
 * closing it in the plane draws a straight line back across the map at about
 * 84.7S. That line is a false coast through the interior, and the fill stops
 * at it instead of reaching the pole — the hole, and the outline around it.
 */
function sweepsGlobe(pts) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0]; }
  return hi - lo > 350;
}

/** Trace one ring, optionally closing it down through the pole. */
function traceRing(ctx, pts, shift, toPole) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = px(pts[i][0], shift), y = py(pts[i][1]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (toPole) {
    // down to the bottom edge of the map and back, so the fill takes in
    // everything between the coast and the pole
    ctx.lineTo(px(pts[pts.length - 1][0], shift), H);
    ctx.lineTo(px(pts[0][0], shift), H);
  }
  ctx.closePath();
}

function tracePolygon(ctx, poly, shift) {
  ctx.beginPath();
  for (const ring of poly) {
    const pts = unwrap(ring);
    for (let i = 0; i < pts.length; i++) {
      const x = ((pts[i][0] + shift + 180) / 360) * W;
      const y = ((90 - pts[i][1]) / 180) * H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

/**
 * @param {Array} features   decoded country features (lon/lat rings)
 * @param {Object} c         colour tokens
 * @param {number} maxSize   the GPU's maximum texture size, to clamp against
 */
export function buildBaseMap(features, c, maxSize = 4096) {
  // 2:1 equirectangular, so the width is the binding constraint.
  W = Math.max(1024, Math.min(TEXTURE_WIDTH, maxSize));
  H = W / 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = c.ocean;
  ctx.fillRect(0, 0, W, H);

  // Three passes so shapes that straddle the antimeridian close correctly.
  for (const shift of [-360, 0, 360]) {
    for (const f of features) {
      for (const poly of f.polygons) {
        const rings = poly.map(unwrap);
        if (rings.some(sweepsGlobe)) {
          // Antarctica: close each ring through the pole so the continent is
          // solid, and stroke the coast as an open line so the synthetic part
          // of the outline is never drawn.
          for (const pts of rings) {
            traceRing(ctx, pts, shift, sweepsGlobe(pts));
            ctx.fillStyle = c.land;
            ctx.fill();
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const x = px(pts[i][0], shift), y = py(pts[i][1]);
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = c.coast;
            ctx.lineWidth = 2.2;
            ctx.stroke();
          }
          continue;
        }
        tracePolygon(ctx, poly, shift);
        ctx.fillStyle = c.land;
        ctx.fill('evenodd');
        ctx.strokeStyle = c.coast;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    }
  }

  // No graticule: latitude and longitude sit at an angle to the icosahedral
  // grid this map is built on, so the sheet carries the face subdivision
  // instead (see FACE_GRID and the shader in mesh.js). Only the equator stays,
  // as a reference line.
  if (c.equatorOpacity > 0) {
    ctx.globalAlpha = c.equatorOpacity;
    ctx.strokeStyle = c.equator;
    ctx.lineWidth = 2.0;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
