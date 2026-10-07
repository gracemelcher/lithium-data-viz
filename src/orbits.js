// The trade routes that orbit the globe on the landing page.
//
// Each route is a great circle between two countries, lifted off the surface
// so it reads as an orbit rather than a line drawn on the map. Dots travel
// along it: the slerp happens in the vertex shader from the route's two
// endpoints, so nothing is re-uploaded per frame, and a route still reads as a
// dotted line because its dots are spread evenly by phase.
//
// Colour carries direction. A dot leaves its origin in the export colour and
// arrives in the import colour — one shipment, counted at both ends.
import * as THREE from 'three';
import { latLonToVec } from './geo.js';
import { LANDING } from './config.js';

const VERTEX_SHADER = /* glsl */`
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec4 aParams;      // omega, lift, phase, speed
attribute float aSize;
uniform float uTime;
uniform float uScale;
uniform vec3 uExport;
uniform vec3 uImport;
varying vec3 vColor;
varying float vFade;
void main() {
  float omega = aParams.x;
  float t = fract(aParams.z + uTime * aParams.w);
  float so = sin(omega);
  vec3 dir = normalize(aStart * (sin((1.0 - t) * omega) / so)
                     + aEnd   * (sin(t * omega) / so));
  vec3 p = dir * (1.0 + aParams.y * pow(sin(3.14159265 * t), 0.85));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
  gl_Position = projectionMatrix * mv;
  // a quick handover in the middle, so most of a route is unambiguously one
  // colour or the other rather than a muddy blend all the way along
  vColor = mix(uExport, uImport, smoothstep(0.40, 0.60, t));
  vFade = smoothstep(0.0, 0.045, t) * smoothstep(1.0, 0.955, t);
}`;

const FRAGMENT_SHADER = /* glsl */`
uniform float uOpacity;
varying vec3 vColor;
varying float vFade;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.25, r);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a * vFade * uOpacity);
  #include <colorspace_fragment>
}`;

const lerp = (a, b, t) => a + (b - a) * t;
/** Deterministic 0..1 from an index, so a reload looks the same. */
const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };

/**
 * @param {Array}  rows       flow records, largest first
 * @param {Map}    positions  country name -> [lon, lat]
 * @param {number} maxFlow
 * @param {{export: THREE.Color, import: THREE.Color}} colors
 */
export function buildOrbits(rows, positions, maxFlow, colors) {
  // Spread the cage around the globe: the largest flows, but no more than a
  // few from any one exporter, or the whole thing sprays from one hot spot.
  const perOrigin = new Map();
  const picked = [];
  for (const f of rows) {
    const used = perOrigin.get(f.a) || 0;
    if (used >= LANDING.maxPerOrigin) continue;
    perOrigin.set(f.a, used + 1);
    picked.push(f);
    if (picked.length >= LANDING.arcs) break;
  }

  const dots = LANDING.dotsPerArc;
  const start = [], end = [], params = [], size = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();

  picked.forEach((f, i) => {
    const pa = positions.get(f.a), pb = positions.get(f.b);
    if (!pa || !pb) return;
    a.fromArray(latLonToVec(pa[1], pa[0]));
    b.fromArray(latLonToVec(pb[1], pb[0]));
    const omega = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    if (omega < 1e-3) return;

    const lift = lerp(LANDING.minAltitude, LANDING.maxAltitude, hash(i));
    const speed = lerp(LANDING.speed[0], LANDING.speed[1], hash(i + 101));
    const dot = lerp(LANDING.dotSize[0], LANDING.dotSize[1], Math.sqrt(f.v / maxFlow));

    for (let j = 0; j < dots; j++) {
      start.push(a.x, a.y, a.z);
      end.push(b.x, b.y, b.z);
      params.push(omega, lift, j / dots, speed);
      size.push(dot);
    }
  });

  const geo = new THREE.BufferGeometry();
  // `position` goes unused — the shader derives it — but three needs one to
  // know how many points to draw.
  geo.setAttribute('position',
    new THREE.Float32BufferAttribute(new Float32Array(size.length * 3), 3));
  geo.setAttribute('aStart', new THREE.Float32BufferAttribute(start, 3));
  geo.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 3));
  geo.setAttribute('aParams', new THREE.Float32BufferAttribute(params, 4));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));

  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 600 },
    uOpacity: { value: 0 },
    uExport: { value: colors.export },
    uImport: { value: colors.import },
  };
  const points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  }));
  points.frustumCulled = false;
  points.renderOrder = 5;
  return { points, uniforms };
}
