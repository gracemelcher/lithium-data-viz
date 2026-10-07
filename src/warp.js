// Data-driven deformation of the flat map.
//
// There are two implementations behind one interface, chosen by `WARP.mode`:
//
//   'elastic' (default) treats the net as a sheet of material. See elastic.js
//     for what it does and why. The solve runs on the CPU whenever the data
//     changes and bakes its result into a displacement texture, so the shader
//     work is a single texture fetch and the strength slider is a free
//     multiply.
//
//   'field' is the original closed-form sum of per-source pushes — the classic
//     Dougenik cartogram force, linear inside a source's radius and falling
//     off as R/r outside it. Kept so the two can be compared without pulling
//     the elastic path out; it folds the sheet over itself where sources
//     crowd, which is what the elastic version exists to fix.
//
// Either way the deformation is zero along the net's 46 cut edges, so the
// sheet keeps the exact outline it was unfolded with and could still be folded
// back into a globe. The elastic path gets that by pinning those vertices in
// the solve; the field path multiplies by a `hold` factor baked into an
// `aHold` vertex attribute.
//
// The GLSL and the JS below must stay in step: the shader deforms the map, the
// JS deforms the things drawn on top of it (nodes, hit testing). Under
// 'elastic' they read the very same grid of numbers, so they cannot drift.
import * as THREE from 'three';
import { WARP, ELASTIC } from './config.js';
import { BOUNDARY } from './geo.js';
import { ElasticNet, warpRect, makeWarpTexture, uploadWarp } from './elastic.js';

export const MAX_SOURCES = WARP.maxSources;
const MAX_OFFSET = WARP.maxOffset;
const TAIL = WARP.tail;
const REACH = WARP.reach;
const ELASTIC_MODE = WARP.mode !== 'field';

const ELASTIC_GLSL = /* glsl */`
uniform sampler2D uWarpMap;     // the year the transition is coming from
uniform sampler2D uWarpMapB;    // the year it is going to
uniform vec4  uWarpRect;        // x0, y0, 1/width, 1/height of the baked grid
uniform float uWarpAmount;
uniform float uWarpBlend;       // 0 = all of A, 1 = all of B

// The hold argument is unused here: the silhouette is pinned in the solve, so
// the baked field is already zero on the cut edges. Tapering again would
// shrink the deformation near the edges past what the material actually does.
// The argument stays so both modes share one call signature.
//
// Two grids rather than one so that playing the timeline can cross between
// adjacent years without re-solving: a solve costs tens of milliseconds and
// could never run per frame, but mixing two solved fields is one extra fetch.
// The mix of two solutions is not itself a solution of the elastic problem,
// which in general would be a licence for the sheet to fold. It holds here
// because consecutive years are a small perturbation of each other — the
// displacement field barely moves between them — so the straight line between
// the two stays inside the well-behaved region around both. setWarpSources
// checks each solve for inversions; the blend adds no new ones in between.
vec2 warpOffset(vec2 p, float hold) {
  if (uWarpAmount <= 0.0) return vec2(0.0);
  vec2 uv = (p - uWarpRect.xy) * uWarpRect.zw;
  vec2 a = texture2D(uWarpMap, uv).rg;
  vec2 b = texture2D(uWarpMapB, uv).rg;
  return mix(a, b, uWarpBlend) * uWarpAmount;
}
`;

const FIELD_GLSL = /* glsl */`
uniform int   uWarpCount;
uniform float uWarpAmount;
uniform vec2  uWarpPos[${MAX_SOURCES}];
uniform float uWarpR[${MAX_SOURCES}];
uniform float uWarpS[${MAX_SOURCES}];

vec2 warpOffset(vec2 p, float hold) {
  if (hold <= 0.0 || uWarpAmount <= 0.0) return vec2(0.0);
  vec2 d = vec2(0.0);
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    if (i >= uWarpCount) break;
    vec2 v = p - uWarpPos[i];
    float r = max(length(v), 1e-4);
    float R = uWarpR[i];
    if (r > R * ${REACH.toFixed(2)}) continue;
    float falloff = (r < R)
      ? (r / R)
      : pow(R / r, ${TAIL.toFixed(2)})
        * (1.0 - smoothstep(R * ${(REACH * 0.55).toFixed(2)}, R * ${REACH.toFixed(2)}, r));
    d += (v / r) * (R * (uWarpS[i] - 1.0)) * falloff;
  }
  float m = length(d);
  if (m > ${MAX_OFFSET.toFixed(2)}) d *= ${MAX_OFFSET.toFixed(2)} / m;
  return d * uWarpAmount * hold;
}
`;

export const WARP_GLSL = ELASTIC_MODE ? ELASTIC_GLSL : FIELD_GLSL;

// One sheet, one solve: the elastic state is a module singleton so that every
// call site keeps the signatures it had under the analytic field.
//
// `gridA`/`gridB` are the two baked fields the shader mixes between, and the
// CPU twin samples the same pair so the two cannot disagree. `slot` says which
// of the two the next solve writes into.
let net = null, rect = null, texW = 0, texH = 0;
let gridA = null, gridB = null, slot = 'B';

export function makeWarpUniforms() {
  if (!ELASTIC_MODE) {
    const pos = [], r = new Float32Array(MAX_SOURCES), s = new Float32Array(MAX_SOURCES);
    for (let i = 0; i < MAX_SOURCES; i++) pos.push(new THREE.Vector2());
    return {
      uWarpCount: { value: 0 },
      uWarpAmount: { value: 0 },
      uWarpPos: { value: pos },
      uWarpR: { value: r },
      uWarpS: { value: s },
    };
  }
  net = new ElasticNet();
  rect = warpRect();
  [texW, texH] = ELASTIC.texture;
  gridA = new Float32Array(texW * texH * 2);
  gridB = new Float32Array(texW * texH * 2);
  slot = 'B';
  const texture = makeWarpTexture(texW, texH);
  const textureB = makeWarpTexture(texW, texH);
  if (typeof console !== 'undefined') {
    console.info(`elastic net: ${net.vertexCount} vertices, ${net.edgeCount} lines, `
      + `${net.triangleCount} triangles; field baked at ${texW}x${texH}`);
  }
  return {
    uWarpMap: { value: texture },
    uWarpMapB: { value: textureB },
    uWarpRect: { value: new THREE.Vector4(rect.x0, rect.y0, 1 / rect.w, 1 / rect.h) },
    uWarpAmount: { value: 0 },
    uWarpBlend: { value: 0 },
  };
}

/**
 * Hand the current destination field back to the source slot, so the next
 * solve can fill the destination with the year after it. Nothing is copied:
 * the two textures and the two grids simply swap roles, and the blend resets
 * to the start of the new interval.
 *
 * Call this once per step of the timeline, before solving the new year.
 */
export function advanceWarpSlot(u) {
  if (!ELASTIC_MODE) return;
  const t = u.uWarpMap.value;
  u.uWarpMap.value = u.uWarpMapB.value;
  u.uWarpMapB.value = t;
  const g = gridA; gridA = gridB; gridB = g;
  u.uWarpBlend.value = 0;
}

/** Where between the two baked years the sheet currently sits, 0..1. */
export function setWarpBlend(u, t) {
  if (!ELASTIC_MODE) return;
  u.uWarpBlend.value = t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Solve the sheet for one year's sources and bake it.
 *
 * `into` is 'both' for an ordinary change — a scrub, a new metric, a layer
 * toggled — where there is only one year on screen and the blend has nothing
 * to interpolate; both grids get the same field so `uWarpBlend` cannot matter.
 * Timeline playback passes 'B' instead, having just called advanceWarpSlot to
 * move the year it is leaving into A.
 *
 * @param {Array<{x:number,y:number,radius:number,scale:number}>} sources
 * @param {'both'|'B'} into
 */
export function setWarpSources(u, sources, into = 'both') {
  if (!ELASTIC_MODE) {
    const n = Math.min(sources.length, MAX_SOURCES);
    for (let i = 0; i < n; i++) {
      u.uWarpPos.value[i].set(sources[i].x, sources[i].y);
      u.uWarpR.value[i] = sources[i].radius;
      u.uWarpS.value[i] = sources[i].scale;
    }
    u.uWarpCount.value = n;
    return;
  }
  // Skipped when the sources are unchanged, so switching theme or highlight —
  // both of which rebuild everything else — costs nothing here. A solve into B
  // alone cannot be skipped on that test, because B holds the *previous*
  // year's field after the slot swap, not the one the test last saw.
  if (!net.solve(sources, false, into === 'B') && into !== 'B') return;
  // A warm start is a guess, and a bad enough guess can settle somewhere
  // folded — switching metric swaps the whole target field at once, and the
  // 'net' metric flips exporters to importers. If anything is still inverted
  // after untangling, throw the guess away and solve from the flat sheet. One
  // retry is enough; a cold solve has not produced an inversion yet.
  if (net.stats && net.stats.inverted > 0 && net.stats.warm) net.solve(sources, true);
  net.rasterise(gridB, texW, texH, rect);
  uploadWarp(u.uWarpMapB.value, gridB, texW, texH);
  if (into === 'both') {
    gridA.set(gridB);
    uploadWarp(u.uWarpMap.value, gridB, texW, texH);
    u.uWarpBlend.value = 0;
  }
  if (net.stats && !net.stats.skipped && typeof console !== 'undefined') {
    const s = net.stats;
    console.info(`elastic solve: ${s.ms}ms, ${s.sources} sources, `
      + `max displacement ${s.maxDisp.toFixed(3)}, inverted triangles ${s.inverted}`);
  }
}

/**
 * 0 on the net's cut edges, easing up to 1 further in than WARP.borderHold.
 * Takes an undeformed net coordinate. Only the 'field' mode uses the value;
 * the attribute is still built under 'elastic' so the two can be swapped.
 */
export function borderHold(x, y) {
  let best = Infinity;
  for (const [a, b] of BOUNDARY) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    let t = ((x - a[0]) * abx + (y - a[1]) * aby) / (abx * abx + aby * aby);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (a[0] + abx * t), dy = y - (a[1] + aby * t);
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  const k = Math.sqrt(best) / WARP.borderHold;
  return k >= 1 ? 1 : k * k * (3 - 2 * k);
}

/**
 * CPU twin of warpOffset(). Under 'elastic' this is a bilinear tap of the very
 * grid the texture was uploaded from, matching what the GPU samples.
 */
export function warpPoint(u, x, y, hold) {
  const amt = u.uWarpAmount.value;
  if (!amt) return [x, y];

  if (ELASTIC_MODE) {
    const b = u.uWarpBlend.value;
    const fx = (x - rect.x0) / rect.w * texW - 0.5;
    const fy = (y - rect.y0) / rect.h * texH - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    let dx = 0, dy = 0;
    for (let j = 0; j <= 1; j++) {
      const yy = Math.min(texH - 1, Math.max(0, iy + j));
      const wy = j ? ty : 1 - ty;
      for (let i = 0; i <= 1; i++) {
        const xx = Math.min(texW - 1, Math.max(0, ix + i));
        const w = (i ? tx : 1 - tx) * wy;
        const o = (yy * texW + xx) * 2;
        // mix then weight, exactly as the shader does: bilinear and lerp both
        // being linear, the order cannot change the answer, but keeping the
        // same order keeps the two implementations readable side by side.
        dx += (gridA[o] + (gridB[o] - gridA[o]) * b) * w;
        dy += (gridA[o + 1] + (gridB[o + 1] - gridA[o + 1]) * b) * w;
      }
    }
    return [x + dx * amt, y + dy * amt];
  }

  const n = u.uWarpCount.value;
  if (!n) return [x, y];
  const h = hold === undefined ? borderHold(x, y) : hold;
  if (h <= 0) return [x, y];
  let dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const p = u.uWarpPos.value[i];
    const vx = x - p.x, vy = y - p.y;
    const r = Math.max(Math.hypot(vx, vy), 1e-4);
    const R = u.uWarpR.value[i];
    if (r > R * REACH) continue;
    let falloff;
    if (r < R) falloff = r / R;
    else {
      const t = (r - R * REACH * 0.55) / (R * REACH - R * REACH * 0.55);
      const e = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      falloff = Math.pow(R / r, TAIL) * (1 - e);
    }
    const k = (R * (u.uWarpS.value[i] - 1)) * falloff / r;
    dx += vx * k; dy += vy * k;
  }
  const m = Math.hypot(dx, dy);
  if (m > MAX_OFFSET) { dx *= MAX_OFFSET / m; dy *= MAX_OFFSET / m; }
  return [x + dx * amt * h, y + dy * amt * h];
}
