// Everything drawn on top of the flat map: trade ribbons, country nodes and
// the case-study pins. All of it lives in net coordinates and is pushed
// through the same warp as the sheet underneath, so it stays registered with
// the map when the grid deforms.
import * as THREE from 'three';
import { WARP_GLSL, borderHold } from './warp.js';
import { netArc, latLonToVec } from './geo.js';
import { RIBBON_WIDTH, ROUTE_DOTS, HEAT } from './config.js';

/**
 * How many categories one heat blob can be divided into. Three is what the
 * case-study data actually uses, and about as many wedges as a soft blob of
 * this size can carry and still be read.
 */
export const HEAT_MAX_CATS = 3;

const RIBBON_VS = /* glsl */`
attribute vec3 aColor;
attribute float aAlpha;
attribute float aHold;
uniform float uZ;
varying vec3 vColor;
varying float vAlpha;
${WARP_GLSL}
void main() {
  vec2 p = position.xy + warpOffset(position.xy, aHold);
  vColor = aColor;
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, uZ, 1.0);
}`;

const RIBBON_FS = /* glsl */`
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha * uOpacity);
  #include <colorspace_fragment>
}`;

const POINT_VS = /* glsl */`
attribute float aSize;
attribute vec3 aColor;
attribute float aKind;
attribute float aHold;          // 0 = node, 1 = case study
uniform float uScale;
uniform float uTime;
uniform float uZ;
varying vec3 vColor;
varying float vKind;
${WARP_GLSL}
void main() {
  vec2 p = position.xy + warpOffset(position.xy, aHold);
  vec4 mv = viewMatrix * vec4(p, uZ, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vKind = aKind;
}`;

const POINT_FS = /* glsl */`
uniform float uOpacity;
uniform vec3 uInk;
varying vec3 vColor;
varying float vKind;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float aa = fwidth(r) * 1.5;
  if (vKind > 0.5) {
    // A case study is drawn as a heat blob (see HEAT_FS); all that is left
    // here is a small white dot marking the exact site. No outline: the dot's
    // alpha simply falls off over a short distance, so the blob behind shows
    // through and the white grades into its own category colour instead of
    // sitting on top of it as a separate mark. The click radius comes from
    // NODE_SIZE.study, not from this, so shrinking the dot costs nothing in
    // how easy the site is to hit.
    float a = smoothstep(0.34, 0.18, r);
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a * uOpacity);
  } else {
    float disc = smoothstep(1.0, 1.0 - aa, r);
    float edge = smoothstep(0.74, 0.74 + aa, r);
    if (disc < 0.01) discard;
    gl_FragColor = vec4(mix(vColor, uInk, edge * 0.55), disc * uOpacity);
  }
  #include <colorspace_fragment>
}`;

// The case-study heat field. One quad per study, sized in net units so the
// blob covers a region of the map rather than a patch of the screen, with a
// Gaussian falloff shifted to reach exactly zero at the rim — otherwise the
// wash ends on a visible circle, which is the ring we were trying to get rid
// of. The whole quad is displaced by the warp sampled at its centre, not
// per-corner, so a blob slides with its site instead of shearing when the
// grid deforms nearby.
const HEAT_VS = /* glsl */`
attribute vec2 aCentre;         // net position of the study, for the warp lookup
attribute vec2 aUv;             // -1..1 across the quad
attribute vec3 aColor;          // the site's categories, in order...
attribute vec3 aColor1;
attribute vec3 aColor2;
attribute float aCount;         // ...and how many of them are live, 1..4
attribute float aHold;
attribute float aIntensity;
uniform float uZ;
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vColor1;
varying vec3 vColor2;
varying float vCount;
varying float vI;
${WARP_GLSL}
void main() {
  vec2 p = position.xy + warpOffset(aCentre, aHold);
  vUv = aUv;
  vColor = aColor;
  vColor1 = aColor1;
  vColor2 = aColor2;
  vCount = aCount;
  vI = aIntensity;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, uZ, 1.0);
}`;

const HEAT_FS = /* glsl */`
uniform float uOpacity;
uniform float uFalloff;
uniform float uPeak;
uniform float uCoreGain;
uniform float uSeam;
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vColor1;
varying vec3 vColor2;
varying float vCount;
varying float vI;

// Index the site's colours without a dynamic array lookup, which GLSL ES 1.0
// will not do on a varying-derived index.
vec3 pickCat(float i, vec3 c0, vec3 c1, vec3 c2, float n) {
  float k = mod(i + n, n);
  vec3 c = c0;
  c = mix(c, c1, step(0.5, k) * step(k, 1.5));
  c = mix(c, c2, step(1.5, k));
  return c;
}

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // Gaussian, shifted and rescaled so dens(0) = 1 and dens(1) = 0 exactly.
  float e = exp(-uFalloff);
  float dens = (exp(-uFalloff * r * r) - e) / (1.0 - e);
  float a = dens * uPeak * vI * uOpacity;
  if (a < 0.004) discard;

  // A site in more than one of the selected categories is divided into a wedge
  // per category rather than being given one of them. The seams are softened
  // over uSeam of a wedge, and only there — the middle of each wedge stays the
  // category's own hue, so the colours are still identifiable. Blending the
  // whole blob instead would average blue and orange into a mud that belongs
  // to neither, and read as a seventh category rather than as two.
  vec3 base = vColor;
  if (vCount > 1.5) {
    float n = vCount;
    float ang = atan(vUv.y, vUv.x) * 0.1591549431 + 0.5;   // 0..1 round the disc
    float f = ang * n;
    float i = floor(f);
    float t = f - i;
    vec3 cur = pickCat(i, vColor, vColor1, vColor2, n);
    vec3 nxt = pickCat(i + 1.0, vColor, vColor1, vColor2, n);
    vec3 prv = pickCat(i - 1.0, vColor, vColor1, vColor2, n);
    // Half weight exactly on a seam, falling to none a seam-width inside.
    float up = smoothstep(1.0 - uSeam, 1.0, t) * 0.5;
    float dn = (1.0 - smoothstep(0.0, uSeam, t)) * 0.5;
    base = cur * (1.0 - up - dn) + nxt * up + prv * dn;
  }

  // Intensity reads as a gain on the category colour rather than a blend
  // toward some other colour, so the hue survives and the categories stay
  // distinguishable at the core. Positive on dark, negative on cream.
  vec3 c = base * (1.0 + uCoreGain * pow(dens, 2.2));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), a);
  #include <colorspace_fragment>
}`;

// Travelling dots along the routes. Position and alpha are stepped on the CPU
// (see advanceDots) because a route is a projected great circle broken at the
// net's cut edges, not something the shader can walk analytically — but the
// warp still happens here, so the dots deform with the sheet like everything
// else drawn on top of it.
const DOT_VS = /* glsl */`
attribute float aSize;
attribute float aProg;          // 0 at the origin, 1 at the destination
attribute float aAlpha;
attribute float aHold;
uniform float uScale;
uniform float uZ;
uniform vec3 uExport;
uniform vec3 uImport;
varying vec3 vColor;
varying float vAlpha;
${WARP_GLSL}
void main() {
  vec2 p = position.xy + warpOffset(position.xy, aHold);
  vec4 mv = viewMatrix * vec4(p, uZ, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
  gl_Position = projectionMatrix * mv;
  // The map's only colour distinction: a dot leaves its origin in the export
  // colour and arrives in the import colour, so a route reads as a direction.
  vColor = mix(uExport, uImport, smoothstep(0.3, 0.7, aProg));
  vAlpha = aAlpha;
}`;

const DOT_FS = /* glsl */`
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 1.0 - fwidth(r) * 2.0, r);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
  #include <colorspace_fragment>
}`;

function ribbonWidth(v, maxFlow) {
  return RIBBON_WIDTH.min + RIBBON_WIDTH.range * Math.sqrt(v / maxFlow);
}

export class Overlay {
  constructor(scene, warpUniforms, colors) {
    this.colors = colors;
    this.ribbonUniforms = {
      uOpacity: { value: 0 }, uZ: { value: 0.008 }, ...warpUniforms,
    };
    this.pointUniforms = {
      uOpacity: { value: 0 }, uZ: { value: 0.02 }, uScale: { value: 600 },
      uTime: { value: 0 }, uInk: { value: new THREE.Color(colors.ink) }, ...warpUniforms,
    };

    this.ribbons = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.ribbonUniforms,
      vertexShader: RIBBON_VS,
      fragmentShader: RIBBON_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.ribbons.renderOrder = 10;
    this.ribbons.frustumCulled = false;

    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.pointUniforms,
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    this.points.renderOrder = 20;
    this.points.frustumCulled = false;

    this.dotUniforms = {
      uOpacity: { value: 0 }, uZ: { value: 0.012 }, uScale: { value: 600 },
      uExport: { value: new THREE.Color(colors.exportHue) },
      uImport: { value: new THREE.Color(colors.importHue) },
      ...warpUniforms,
    };
    this.dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.dotUniforms,
      vertexShader: DOT_VS,
      fragmentShader: DOT_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    this.dots.renderOrder = 15;
    this.dots.frustumCulled = false;
    this.paths = [];                    // one per run: resampled polyline
    this.dotOf = null;                  // per-dot: path index, phase, speed

    // Underneath everything else on the overlay: the heat field reads as part
    // of the map, so the routes and the markers sit on top of it.
    this.heatUniforms = {
      uOpacity: { value: 0 }, uZ: { value: 0.004 },
      uFalloff: { value: HEAT.falloff }, uPeak: { value: HEAT.peak },
      uCoreGain: { value: 0 },
      uSeam: { value: HEAT.seam },
      ...warpUniforms,
    };
    this.heat = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.heatUniforms,
      vertexShader: HEAT_VS,
      fragmentShader: HEAT_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.heat.renderOrder = 5;
    this.heat.frustumCulled = false;

    scene.add(this.ribbons, this.points, this.dots, this.heat);
    this.nodes = [];                    // {code, x, y, total, out, in, study}
    this.arcCache = new Map();
  }

  set opacity(v) {
    this.ribbonUniforms.uOpacity.value = v * ROUTE_DOTS.trackOpacity;
    this.pointUniforms.uOpacity.value = v;
    this.dotUniforms.uOpacity.value = v;
    this.heatUniforms.uOpacity.value = v;
  }

  /** Cached great-circle -> net polylines; the projection is the expensive bit. */
  arc(a, b, va, vb) {
    const key = a + '>' + b;
    let runs = this.arcCache.get(key);
    if (!runs) {
      runs = netArc(va, vb, 56);
      this.arcCache.set(key, runs);
    }
    return runs;
  }

  /**
   * @param {Array} rows      flow records for the current year/categories
   * @param {Map}   vecs      country code -> unit vector
   * @param {Map}   catColor  category key -> THREE.Color
   * @param {string|null} focus  highlight flows touching this country
   */
  setFlows(rows, vecs, catColor, maxFlow, focus) {
    const pos = [], col = [], alpha = [], hold = [];
    const sorted = rows.slice().sort((x, y) => x.v - y.v);
    // The ribbons are the faint track under the dots, off by default — no
    // point building the geometry when nothing will be drawn.
    const track = ROUTE_DOTS.trackOpacity > 0;
    for (const f of (track ? sorted : [])) {
      const c = catColor.get(f.cat);
      if (!c) continue;
      const dim = focus && f.a !== focus && f.b !== focus;
      const base = dim ? 0.07 : 0.62;
      const w = ribbonWidth(f.v, maxFlow) * (dim ? 0.6 : 1);
      for (const run of this.arc(f.a, f.b, vecs.get(f.a), vecs.get(f.b))) {
        for (let i = 0; i < run.length - 1; i++) {
          const p0 = run[i], p1 = run[i + 1];
          let nx = -(p1[1] - p0[1]), ny = p1[0] - p0[0];
          const len = Math.hypot(nx, ny) || 1;
          nx /= len; ny /= len;
          const w0 = w * (0.45 + 0.55 * p0[2]);      // thin at the origin
          const w1 = w * (0.45 + 0.55 * p1[2]);
          const a0 = base * (0.25 + 0.75 * p0[2]);
          const a1 = base * (0.25 + 0.75 * p1[2]);
          const quad = [
            [p0[0] + nx * w0, p0[1] + ny * w0, a0], [p0[0] - nx * w0, p0[1] - ny * w0, a0],
            [p1[0] - nx * w1, p1[1] - ny * w1, a1], [p1[0] + nx * w1, p1[1] + ny * w1, a1],
          ];
          for (const k of [0, 1, 2, 0, 2, 3]) {
            pos.push(quad[k][0], quad[k][1], 0);
            col.push(c.r, c.g, c.b);
            alpha.push(quad[k][2]);
            hold.push(borderHold(quad[k][0], quad[k][1]));
          }
        }
      }
    }
    const g = this.ribbons.geometry;
    g.dispose();
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    ng.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
    ng.setAttribute('aHold', new THREE.Float32BufferAttribute(hold, 1));
    this.ribbons.geometry = ng;

    this.setDots(sorted, vecs, catColor, focus);
  }

  /**
   * Lay travelling dots along the same routes. Each run of a route becomes a
   * path with cumulative arc length, and every dot is a cursor along one of
   * them. Hold is sampled per path vertex and interpolated with the position,
   * so the warp does not have to be re-solved for a moving point every frame.
   */
  setDots(sorted, vecs, catColor, focus) {
    const [nMin, nMax] = ROUTE_DOTS.perRoute;
    const [sMin, sMax] = ROUTE_DOTS.size;
    this.paths = [];
    const dots = [];

    // Trade values span five orders of magnitude — the busiest route here is
    // about 50,000x the median — so density has to be logarithmic. Scaling by
    // the value, or even its square root, pins all but a handful of routes at
    // the minimum. The range is taken from the routes actually drawn, so the
    // spread holds up whichever year and layers are showing.
    //
    // Each end of a year transition is measured against its own year's spread,
    // not the pair's. Sharing one range would quietly shrink every route at
    // the quieter end — the busier year widens the top of the scale, and every
    // weight computed against it comes out lower than that year on its own
    // would give. The field names fall back to `v`, so an ordinary single-year
    // slice builds exactly one range and nothing about it changes.
    const scaleFor = (key) => {
      const vals = sorted
        .map((f) => (f[key] === undefined ? f.v : f[key]))
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
      const lo = Math.log(Math.max(1, vals[0] || 1));
      const hi = Math.log(Math.max(Math.E, vals[vals.length - 1] || Math.E));
      // See ROUTE_DOTS.emphasis: the exponent is what lets the dominant
      // corridors pull away from a log scale that would otherwise bunch them
      // in with routes carrying a fraction of a percent.
      const g = ROUTE_DOTS.emphasis ?? 1;
      return (v) => {
        if (hi <= lo) return 0.5;
        const w = Math.min(1, Math.max(0, (Math.log(Math.max(1, v)) - lo) / (hi - lo)));
        return g === 1 ? w : w ** g;
      };
    };
    const weightOf = scaleFor('v');
    const weightAt = { vA: scaleFor('vA'), vB: scaleFor('vB') };

    for (const f of sorted) {
      if (!catColor.has(f.cat)) continue;        // layer switched off
      const dim = focus && f.a !== focus && f.b !== focus;
      const weight = weightOf(f.v);
      const want = Math.max(1, Math.round(nMin + (nMax - nMin) * weight));
      const size = sMin + (sMax - sMin) * weight;
      const alpha = dim ? ROUTE_DOTS.dimAlpha : ROUTE_DOTS.baseAlpha;
      // The two ends of a year-to-year transition. How many dots a route gets
      // is structural and fixed for the pair, so the difference between the
      // years is carried by alpha and size, which advanceDots rewrites every
      // frame anyway. A route absent in one year has weight 0 there and fades
      // out rather than vanishing between frames. Away from playback vA and vB
      // are the same number and both ends collapse onto the static values.
      const wA = f.vA === undefined ? weight : weightAt.vA(f.vA);
      const wB = f.vB === undefined ? weight : weightAt.vB(f.vB);
      const liveA = f.vA === undefined || f.vA > 0;
      const liveB = f.vB === undefined || f.vB > 0;
      // How many dots this route earns at each end. The geometry holds one
      // count, built for the busier end, so the quieter end does not use all
      // of them: the surplus is switched off there and fades back in as the
      // glide crosses. Dimming the whole route instead would have been simpler
      // and wrong — it would make a route that merely grows next year read as
      // faint this year, and take the brightness of the whole map down with
      // it. Gating keeps each end at exactly the density and the alpha a
      // single-year build gives it, which is the state the map sits in for the
      // whole of a case-study dwell.
      const countAt = (w) => Math.max(1, Math.round(nMin + (nMax - nMin) * w));
      const wantA = liveA ? countAt(wA) : 0;
      const wantB = liveB ? countAt(wB) : 0;
      const sizeA = sMin + (sMax - sMin) * wA;
      const sizeB = sMin + (sMax - sMin) * wB;

      const runs = this.arc(f.a, f.b, vecs.get(f.a), vecs.get(f.b));
      // total length first, so dots are shared out by length not by run count
      let total = 0;
      const prepped = runs.map((run) => {
        const n = run.length;
        const xs = new Float32Array(n), ys = new Float32Array(n);
        const hs = new Float32Array(n), ps = new Float32Array(n), cum = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          xs[i] = run[i][0]; ys[i] = run[i][1];
          hs[i] = borderHold(run[i][0], run[i][1]);
          ps[i] = run[i][2];                 // progress along the whole route
          cum[i] = i ? cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) : 0;
        }
        total += cum[n - 1];
        return { xs, ys, hs, ps, cum, len: cum[n - 1] };
      });
      if (total <= 1e-6) continue;

      for (const path of prepped) {
        const frac = path.len / total;
        const share = Math.max(1, Math.round(want * frac));
        // This path's share of each end's count, never more than the dots that
        // actually exist. Dots at or past it are dark at that end.
        // The same max(1, ...) floor the union count gets, so that a route
        // present at an end always keeps at least one dot there — without it a
        // short path would round to nothing and a live route would go dark,
        // including on the ordinary single-year map where both ends agree.
        const shareOf = (n) => (n > 0 ? Math.min(share, Math.max(1, Math.round(n * frac))) : 0);
        const shareA = shareOf(wantA);
        const shareB = shareOf(wantB);
        const pi = this.paths.push(path) - 1;
        for (let k = 0; k < share; k++) {
          dots.push({
            path: pi,
            phase: (k + Math.random() * 0.6) / share,     // spread, not a queue
            speed: ROUTE_DOTS.speed
              * (1 + (Math.random() * 2 - 1) * ROUTE_DOTS.speedVary),
            size, alpha,
            alphaA: k < shareA ? alpha : 0,
            alphaB: k < shareB ? alpha : 0,
            sizeA, sizeB,
          });
        }
      }
    }

    const n = dots.length;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n), al = new Float32Array(n);
    const hold = new Float32Array(n), prog = new Float32Array(n);
    for (let i = 0; i < n; i++) size[i] = dots[i].size;
    const ng2 = new THREE.BufferGeometry();
    ng2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ng2.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    ng2.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
    ng2.setAttribute('aHold', new THREE.BufferAttribute(hold, 1));
    ng2.setAttribute('aProg', new THREE.BufferAttribute(prog, 1));
    this.dots.geometry.dispose();
    this.dots.geometry = ng2;
    this.dotOf = dots;
    this.dotSeg = new Int32Array(n);
    this.advanceDots(0);
  }

  /**
   * Step every dot along its path. `t` is seconds; the motion loops.
   *
   * `blend` is where between the two years the timeline currently sits, 0..1.
   * The dots are the only thing drawn for a route, so this is where a year
   * transition is actually made fluid: both ends were baked into each dot when
   * the geometry was built, and every frame reads a point on the line between
   * them. It costs one lerp in a loop that was already running.
   */
  advanceDots(t, blend = 0) {
    const dots = this.dotOf;
    if (!dots || !dots.length) return;
    const g = this.dots.geometry;
    const pos = g.getAttribute('position'), al = g.getAttribute('aAlpha');
    const hold = g.getAttribute('aHold'), prg = g.getAttribute('aProg');
    const sz = g.getAttribute('aSize');
    const P = pos.array, A = al.array, H = hold.array, G = prg.array;
    const S = sz.array;
    const fade = ROUTE_DOTS.fade;
    const b = blend < 0 ? 0 : blend > 1 ? 1 : blend;

    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const path = this.paths[d.path];
      // phase in [0,1): distance travelled at a constant speed, wrapped
      let u = d.phase + (t * d.speed) / path.len;
      u -= Math.floor(u);
      const want = u * path.len;
      const cum = path.cum;
      // the cursor only ever moves forward, so walking it is O(1) amortised
      let j = this.dotSeg[i];
      if (cum[j] > want) j = 0;
      while (j < cum.length - 2 && cum[j + 1] < want) j++;
      this.dotSeg[i] = j;
      const span = cum[j + 1] - cum[j] || 1;
      const f = (want - cum[j]) / span;
      P[i * 3] = path.xs[j] + (path.xs[j + 1] - path.xs[j]) * f;
      P[i * 3 + 1] = path.ys[j] + (path.ys[j + 1] - path.ys[j]) * f;
      H[i] = path.hs[j] + (path.hs[j + 1] - path.hs[j]) * f;
      G[i] = path.ps[j] + (path.ps[j + 1] - path.ps[j]) * f;
      // ease in and out so dots appear and vanish rather than popping
      const a = d.alphaA === undefined
        ? d.alpha
        : d.alphaA + (d.alphaB - d.alphaA) * b;
      A[i] = a * Math.min(1, u / fade) * Math.min(1, (1 - u) / fade);
      if (d.sizeA !== undefined) S[i] = d.sizeA + (d.sizeB - d.sizeA) * b;
    }
    pos.needsUpdate = true; al.needsUpdate = true;
    hold.needsUpdate = true; prg.needsUpdate = true;
    sz.needsUpdate = true;
  }

  /** @param {Array} nodes  {x, y, size, kind, color} in net coordinates */
  setNodes(nodes) {
    this.nodes = nodes;
    const pos = [], size = [], col = [], kind = [], hold = [];
    for (const n of nodes) {
      pos.push(n.x, n.y, 0);
      size.push(n.size);
      kind.push(n.kind === 'study' ? 1 : 0);
      col.push(n.color.r, n.color.g, n.color.b);
      hold.push(n.hold !== undefined ? n.hold : borderHold(n.x, n.y));
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    ng.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    ng.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    ng.setAttribute('aHold', new THREE.Float32BufferAttribute(hold, 1));
    this.points.geometry.dispose();
    this.points.geometry = ng;
    this.blendNodes(0);
  }

  /**
   * Resize the country dots for a point between two years.
   *
   * Only the size moves: which countries are on the map is the union of the
   * two years and does not change mid-transition, and a country with no trade
   * in one of them has size 0 there, so it grows out of nothing instead of
   * appearing. Nodes without a pair — the case studies, which do not answer to
   * the year at all — are left alone.
   */
  blendNodes(blend) {
    const nodes = this.nodes;
    if (!nodes || !nodes.length) return;
    const sz = this.points.geometry.getAttribute('aSize');
    if (!sz) return;
    const b = blend < 0 ? 0 : blend > 1 ? 1 : blend;
    const S = sz.array;
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.sizeA === undefined) continue;
      S[i] = n.sizeA + (n.sizeB - n.sizeA) * b;
      moved = true;
    }
    if (moved) sz.needsUpdate = true;
  }

  /**
   * The case-study heat field.
   * @param {Array} blobs  {x, y, color: THREE.Color, intensity, hold?}
   */
  setHeat(blobs) {
    const n = blobs.length;
    const pos = new Float32Array(n * 4 * 3);
    const centre = new Float32Array(n * 4 * 2);
    const uv = new Float32Array(n * 4 * 2);
    const col = new Float32Array(n * 4 * 3);
    const col1 = new Float32Array(n * 4 * 3);
    const col2 = new Float32Array(n * 4 * 3);
    const count = new Float32Array(n * 4);
    const hold = new Float32Array(n * 4);
    const inten = new Float32Array(n * 4);
    const idx = new Uint16Array(n * 6);
    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const r = HEAT.radius;
    for (let i = 0; i < n; i++) {
      const b = blobs[i];
      const h = b.hold !== undefined ? b.hold : borderHold(b.x, b.y);
      // `colors` is the site's live categories; `color` remains the one-colour
      // form every other call site already passes.
      const cs = (b.colors && b.colors.length ? b.colors : [b.color])
        .slice(0, HEAT_MAX_CATS);
      const c0 = cs[0], c1 = cs[1] || cs[0], c2 = cs[2] || cs[0];
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k, [cx, cy] = CORNERS[k];
        pos[v * 3] = b.x + cx * r;
        pos[v * 3 + 1] = b.y + cy * r;
        centre[v * 2] = b.x;
        centre[v * 2 + 1] = b.y;
        uv[v * 2] = cx;
        uv[v * 2 + 1] = cy;
        col[v * 3] = c0.r; col[v * 3 + 1] = c0.g; col[v * 3 + 2] = c0.b;
        col1[v * 3] = c1.r; col1[v * 3 + 1] = c1.g; col1[v * 3 + 2] = c1.b;
        col2[v * 3] = c2.r; col2[v * 3 + 1] = c2.g; col2[v * 3 + 2] = c2.b;
        count[v] = cs.length;
        hold[v] = h;
        inten[v] = b.intensity;
      }
      const o = i * 4;
      idx.set([o, o + 1, o + 2, o, o + 2, o + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCentre', new THREE.BufferAttribute(centre, 2));
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aColor1', new THREE.BufferAttribute(col1, 3));
    g.setAttribute('aColor2', new THREE.BufferAttribute(col2, 3));
    g.setAttribute('aCount', new THREE.BufferAttribute(count, 1));
    g.setAttribute('aHold', new THREE.BufferAttribute(hold, 1));
    g.setAttribute('aIntensity', new THREE.BufferAttribute(inten, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.heat.geometry.dispose();
    this.heat.geometry = g;
  }
}

export function countryVectors(positions) {
  const vecs = new Map();
  for (const [code, ll] of positions) vecs.set(code, latLonToVec(ll[1], ll[0]));
  return vecs;
}
